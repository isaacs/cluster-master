// Set up a cluster and set up resizing and such.

var cluster = require("cluster")
, quitting = false
, restarting = false
, path = require("path")
, clusterSize = 0
, env
, os = require("os")
, onmessage
, repl = require('repl')
, net = require('net')
, EventEmitter = require('events').EventEmitter
, masterEmitter = new EventEmitter()
, fs = require('fs')
, util = require('util')

exports = module.exports = clusterMaster
exports.emitter = emitter
exports.restart = emitAndRestart
exports.resize = emitAndResize
exports.quitHard = emitAndQuitHard
exports.quit = emitAndQuit

var debugStreams = {}
function debug () {
  console.error.apply(console, arguments)

  var msg = util.format.apply(util, arguments)
  Object.keys(debugStreams).forEach(function (s) {
    try {
      // if the write fails, just remove it.
      debugStreams[s].write(msg + '\n')
      if (debugStreams[s].repl) debugStreams[s].repl.displayPrompt()
    } catch (e) {
      delete debugStreams[s]
    }
  })
}


function clusterMaster (config) {
  if (typeof config === "string") config = { exec: config }

  if (!config.exec) {
    throw new Error("Must define a 'exec' script")
  }

  if (!cluster.isMaster) {
    throw new Error("ClusterMaster answers to no one!\n"+
                    "(don't run in a cluster worker script)")
  }

  if (cluster._clusterMaster) {
    throw new Error("This cluster has a master already")
  }

  cluster._clusterMaster = module.exports

  onmessage = config.onMessage || config.onmessage

  clusterSize = config.size || os.cpus().length

  env = config.env

  var masterConf = { exec: path.resolve(config.exec) }
  if (config.silent) masterConf.silent = true
  if (config.env) masterConf.env = config.env
  if (config.args) masterConf.args = config.args

  cluster.setupMaster(masterConf)

  if (config.signals !== false) {
    // sighup/sigint listeners
    setupSignals()
  }

  forkListener()

  // now make it the right size
  debug('resize and then setup repl')
  resize(setupRepl)

  return masterEmitter
}

function select (field) {
  return Object.keys(cluster.workers).map(function (k) {
    return [k, cluster.workers[k][field]]
  }).reduce(function (set, kv) {
    set[kv[0]] = kv[1]
    return set
  }, {})
}

function setupRepl () {
  debug('setup repl')
  var socket = path.resolve('cluster-master-socket')
  if (process.env.CLUSTER_MASTER_REPL) {
    socket = process.env.CLUSTER_MASTER_REPL
    if (!isNaN(socket)) socket = +socket
  }
  var connections = 0

  if (typeof socket === 'string') {
    fs.unlink(socket, function (er) {
      if (er && er.code !== 'ENOENT') throw er
      startRepl()
    })
  } else {
    startRepl()
  }

  function startRepl () {
    var sockId = 0
    net.createServer(function (sock) {
      connections ++
      replEnded = false

      sock.id = sockId ++
      debugStreams['repl-' + sockId] = sock

      sock.write('Starting repl #' + sock.id)
      var r = repl.start({
        prompt: 'ClusterMaster ' + process.pid + ' ' + sock.id + '> ',
        input: sock,
        output: sock,
        terminal: true,
        useGlobal: false,
        ignoreUndefined: true
      })
      var context = {
        repl: r,
        resize: emitAndResize,
        restart: emitAndRestart,
        quit: emitAndQuit,
        quitHard: emitAndQuitHard,
        cluster: cluster,
        get size () {
          return clusterSize
        },
        get connections () {
          return connections
        },
        get workers () {
          var p = select('pid')
          var s = select('state')
          var a = select('age')
          return Object.keys(cluster.workers).map(function (k) {
            return new Worker({ id: k, pid: p[k], state: s[k], age: a[k] })
          })
        },
        select: select,
        get pids () {
          return select('pid')
        },
        get ages () {
          return select('age')
        },
        get states () {
          return select('state')
        },
        // like 'wall'
        debug: debug,
        sock: sock
      }
      var desc = Object.getOwnPropertyNames(context).map(function (n) {
        return [n, Object.getOwnPropertyDescriptor(context, n)]
      }).reduce(function (set, kv) {
        set[kv[0]] = kv[1]
        return set
      }, {})
      Object.defineProperties(r.context, desc)

      sock.repl = r

      r.on('end', function () {
        connections --
        replEnded = true
        if (!ended) sock.end()
      })

      sock.on('end', end)
      sock.on('close', end)
      sock.on('error', end)

      ended = false
      function end () {
        if (ended) return
        ended = true
        if (!replEnded) r.rli.close()
        delete debugStreams['repl-' + sockId]
      }

    }).listen(socket, function () {
      debug('ClusterMaster repl listening on '+socket)
    })
  }
}

function Worker (d) {
  this.id = d.id
  this.pid = d.pid
  this.state = d.state
  this.age = d.age
}

Worker.prototype.disconnect = function () {
  cluster.workers[this.id].disconnect()
}

Worker.prototype.kill = function () {
  process.kill(this.pid)
}


function forkListener () {
  cluster.on("fork", function (worker) {
    worker.birth = Date.now()
    Object.defineProperty(worker, 'age', { get: function () {
      return Date.now() - this.birth
    }, enumerable: true, configurable: true })
    worker.pid = worker.process.pid
    var id = worker.id
    debug("Worker %j setting up", id)
    if (onmessage) worker.on("message", onmessage)
    var disconnectTimer

    worker.on("exit", function () {
      clearTimeout(disconnectTimer)

      if (!worker.suicide) {
        debug("Worker %j exited abnormally", id)
        // don't respawn right away if it's a very fast failure.
        // otherwise server crashes are hard to detect from monitors.
        if (worker.age < 2000) {
          debug("Worker %j died too quickly, not respawning.", id)
          return
        }
      } else {
        debug("Worker %j exited", id)
      }

      if (Object.keys(cluster.workers).length < clusterSize && !resizing) {
        resize()
      }
    })

    worker.on("disconnect", function () {
      debug("Worker %j disconnect", id)
      // give it 1 second to shut down gracefully, or kill
      disconnectTimer = setTimeout(function () {
        debug("Worker %j, forcefully killing", id)
        worker.process.kill("SIGKILL")
      }, 5000)
    })
  })
}

function restart (cb) {
  if (restarting) {
    debug("Already restarting.  Cannot restart yet.")
    return
  }

  restarting = true

  // graceful restart.
  // all the existing workers get killed, and this
  // causes new ones to be spawned.  If there aren't
  // already the intended number, then fork new extras.
  var current = Object.keys(cluster.workers)
  , length = current.length
  , reqs = clusterSize - length

  var i = 0

  // if we're resizing, then just kill off a few.
  if (reqs !== 0) {
    debug('resize %d -> %d, change = %d',
                  current.length, clusterSize, reqs)

    return resize(clusterSize, function () {
      debug('resize cb')
      length = clusterSize
      graceful()
    })
  }

  // all the current workers, kill and then wait for a
  // new one to spawn before moving on.
  graceful()
  function graceful () {
    debug("graceful %d of %d", i, length)
    if (i >= current.length) {
      debug("graceful completion")
      restarting = false
      return cb && cb()
    }

    var first = (i === 0)
    , id = current[i++]
    , worker = cluster.workers[id]

    if (quitting) {
      if (worker && worker.process.connected) {
        worker.disconnect()
      }
      return graceful()
    }

    // start a new one. if it lives for 2 seconds, kill the worker.
    if (first) {
      cluster.once('listening', function (newbie) {
        var timer = setTimeout(function () {
          newbie.removeListener('exit', skeptic)
          if (worker && worker.process.connected) {
            worker.disconnect()
          }
          graceful()
        }, 2000)
        newbie.on('exit', skeptic)
        function skeptic () {
          debug('New worker died quickly. Aborting restart.')
          restarting = false
          clearTimeout(timer)
        }
      })
    } else {
      cluster.once('listening', function (newbie) {
        if (worker && worker.process.connected) {
          worker.disconnect()
        }
      })
      graceful()
    }

    cluster.fork(env)
  }
}



var resizing = false
function resize (n, cb) {
  if (typeof n === 'function') cb = n, n = clusterSize

  if (resizing) {
    return cb && cb()
  }

  if (n >= 0) clusterSize = n
  var current = Object.keys(cluster.workers)
  , c = current.length
  , req = clusterSize - c

  if (c === clusterSize) {
    resizing = false
    return cb && cb()
  }

  var thenCnt = 0
  function then () {
    thenCnt ++
    return then2
  }
  function then2 () {
    if (--thenCnt === 0) {
      resizing = false
      return cb && cb()
    }
  }

  // make us have the right number of them.
  if (req > 0) while (req -- > 0) {
    debug('resizing up', req)
    cluster.once('listening', then())
    cluster.fork(env)
  } else for (var i = clusterSize; i < c; i ++) {
    var worker = cluster.workers[current[i]]
    debug('resizing down', current[i])
    worker.once('exit', then())
    if (worker && worker.process.connected) {
      worker.disconnect()
    }
  }
}



function quitHard () {
  quitting = true
  quit()
}



function quit () {
  if (quitting) {
    debug("Forceful shutdown")
    // last ditch effort to force-kill all workers.
    Object.keys(cluster.workers).forEach(function (id) {
      var w = cluster.workers[id]
      if (w && w.process) w.process.kill("SIGKILL")
    })
    process.exit(1)
  }

  debug("Graceful shutdown...")
  clusterSize = 0
  quitting = true
  restart(function () {
    debug("Graceful shutdown successful")
    process.exit(0)
  })
}


function setupSignals () {
  try {
    process.on("SIGHUP", emitAndRestart)
    process.on("SIGINT", emitAndQuit)
    process.on("SIGKILL", emitAndQuitHard)
  } catch (e) {
    // Must be on Windows, waaa-waaah.
  }

  process.on("exit", function () {
    if (!quitting) quitHard()
  })
}

function emitter() {
  return masterEmitter
}

function emitAndResize(n) {
  masterEmitter.emit('resize', n)
  process.nextTick(function () { resize(n) })
}

function emitAndRestart(cb) {
  if (restarting) {
    debug("Already restarting.  Cannot restart yet.")
    return
  }
  var currentWorkers = Object.keys(cluster.workers).reduce(function (accum, k) {
    accum[k] = { pid: cluster.workers[k].pid };
    return accum;
  }, {});
  masterEmitter.emit('restart', currentWorkers);
  process.nextTick(function () {
    restart(function () {
      masterEmitter.emit('restartComplete');
      if (cb) cb();
    });
  });
}

function emitAndQuit() {
  masterEmitter.emit('quit')
  process.nextTick(function () { quit() })
}

function emitAndQuitHard() {
  masterEmitter.emit('quitHard')
  process.nextTick(function () { quitHard() })
}