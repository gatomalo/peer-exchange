var EventEmitter = require('events')
var util = require('util')
var duplexify = require('duplexify').obj
var mux = require('multiplex')
var ndjson = require('ndjson')

var MAGIC_HEADER = new Buffer('ed3bccf6', 'hex')
var PROTOCOL_VERSION = 0

// TODO: support arbitrary streams to mux many protocols across one peer connection
module.exports = Peer
function Peer (id, opts) {
  if (!id || typeof id !== 'string') {
    throw new Error('A network id must be specified')
  }
  if (!(this instanceof Peer)) {
    return new Peer(opts)
  }
  EventEmitter.call(this)

  this.id = id
  opts = opts || {}
  this._accepts = opts.accepts || {}
  this._remoteAccepts = null
  this.socket = null
  this.mux = null
  this._exchangeChannel = null
  this._dataChannel = null

  this._error = this._error.bind(this)
}
util.inherits(Peer, EventEmitter)

Peer.prototype._error = function (err) {
  this.destroy()
  this.emit('error', err)
}

Peer.prototype.connect = function (socket) {
  if (!socket || !socket.readable || !socket.writable) {
    throw new Error('Must specify a connected duplex stream socket')
  }
  this.socket = socket
  this.socket.on('error', this._error)
  this.socket.on('close', () => this.emit('close'))

  this.socket.write(MAGIC_HEADER)
  read(this.socket, this._onHeader.bind(this))
}

Peer.prototype._onHeader = function (data) {
  var magic = data.slice(0, MAGIC_HEADER.length)
  if (magic.compare(MAGIC_HEADER) !== 0) {
    return this._error(new Error('Invalid magic bytes'))
  }

  this.mux = mux()
  this.mux.on('error', this._error)
  this.mux.pipe(this.socket).pipe(this.mux)

  this._exchangeChannel = this.createObjectChannel('pxp')
  this._dataChannel = this.createChannel('data')
  this.read = this._dataChannel.read.bind(this._dataChannel)
  this.write = this._dataChannel.write.bind(this._dataChannel)
  this._dataChannel.on('data', (data) => this.emit('data', data))

  this._handshake()
}

Peer.prototype._handshake = function () {
  var accepts = {}
  for (var transportId in this._accepts) {
    accepts[transportId] = this._accepts[transportId].opts
  }

  this._exchangeChannel.write({
    id: this.id,
    version: PROTOCOL_VERSION,
    accepts
  })

  read(this._exchangeChannel, (message) => {
    if (typeof message !== 'object') {
      return this._error(new Error('Invalid handshake message'))
    }
    if (message.id !== this.id) {
      return this._error(new Error('Peer\'s network id ("' + message.id + '") ' +
        'is different than expected ("' + this.id + '")'))
    }
    if (message.version !== PROTOCOL_VERSION) {
      return this._error(new Error('Peer is using a different protocol version ' +
        '(theirs: ' + message.version + ', ours: ' + PROTOCOL_VERSION + ')'))
    }
    this._remoteAccepts = message.accepts

    this._exchangeChannel.write('ack')
    read(this._exchangeChannel, (message) => {
      if (message !== 'ack') {
        return this._error(new Error('Invalid handshake ack'))
      }
      this.emit('ready')
    })
  })
}

Peer.prototype.createObjectChannel = function (id, opts) {
  var muxStream = this.mux.createSharedStream(id, opts)
  muxStream.on('error', this._error)

  var parse = ndjson.parse()
  muxStream.pipe(parse)

  var serialize = ndjson.serialize()
  serialize.pipe(muxStream)

  var channel = duplexify(serialize, parse)
  channel.on('error', this._error)
  return channel
}

Peer.prototype.createChannel = function (id, opts) {
  var channel = this.mux.createSharedStream(id, opts)
  channel.on('error', this._error)
  return channel
}

Peer.prototype.getNewPeer = function (cb) {

}

Peer.prototype.send = function (data) {
  this._exchangeChannel
}

Peer.prototype.destroy = function () {
  this.socket.destroy()
}

function read (stream, cb) {
  var data = stream.read()
  if (data) return cb(data)
  stream.once('data', cb)
}
