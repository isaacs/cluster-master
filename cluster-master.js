// Set up a cluster and set up resizing and such.

var cluster = require("cluster")
, quitting = false
, restarting = false
, path = require("path")
, clusterSize = 0
, os = require("os")
, onmessage

exports = module.exports = clusterMaster
exports.restart = restart
exports.resize = resize
exports.quitHard = quitHard
exports.quit = quit

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

  var masterConf = { exec: path.resolve(config.exec) }
  if (config.silent) masterConf.silent = true
  if (config.env) masterConf.env = config.env

  cluster.setupMaster(masterConf)

  if (config.signals !== false) {
    // sighup/sigint listeners
    setupSignals()
  }

  forkListener()

  // now make it the right size
  resize()
}

function forkListener () {
  cluster.on("fork", function (worker) {
    worker.birth = Date.now()
    var id = worker.id
    console.error("Worker %j setting up", id)
    if (onmessage) worker.on("message", onmessage)
    var disconnectTimer

    worker.on("exit", function () {
      clearTimeout(disconnectTimer)

      if (!worker.suicide) {
        console.error("Worker %j exited abnormally", id)
        // don't respawn right away if it's a very fast failure.
        // otherwise server crashes are hard to detect from monitors.
        var age = Date.now() - worker.birth
        if (age < 2000) {
          console.error("Worker %j died too quickly, not respawning.", id)
          return
        }
      } else {
        console.error("Worker %j exited", id)
      }

      if (Object.keys(cluster.workers).length < clusterSize && !resizing) {
        resize()
      }
    })

    worker.on("disconnect", function () {
      console.error("Worker %j disconnect", id)
      // give it 1 second to shut down gracefully, or kill
      disconnectTimer = setTimeout(function () {
        console.error("Worker %j, forcefully killing", id)
        worker.process.kill("SIGKILL")
      }, 5000)
    })
  })
}

function restart (cb) {
  if (restarting) {
    console.error("Already restarting.  Cannot restart yet.")
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
    console.error('resize %d -> %d, change = %d',
                  current.length, clusterSize, reqs)

    return resize(clusterSize, function () {
      console.error('resize cb')
      length = clusterSize
      graceful()
    })
  }

  // all the current workers, kill and then wait for a
  // new one to spawn before moving on.
  graceful()
  function graceful () {
    console.error("graceful %d of %d", i, length)
    if (i >= current.length) {
      console.error("graceful completion")
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
          console.error('New worker died quickly. Aborting restart.')
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

    cluster.fork()
  }
}



var resizing = false
function resize (n, cb) {
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
    console.error('resizing up', req)
    cluster.once('listening', then())
    cluster.fork()
  } else for (var i = clusterSize; i < c; i ++) {
    var worker = cluster.workers[current[i]]
    console.error('resizing down', current[i])
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
    console.error("Forceful shutdown")
    // last ditch effort to force-kill all workers.
    Object.keys(cluster.workers).forEach(function (id) {
      var w = cluster.workers[id]
      if (w && w.process) w.process.kill("SIGKILL")
    })
    process.exit(1)
  }

  console.error("Graceful shutdown...")
  clusterSize = 0
  quitting = true
  restart(function () {
    console.error("Graceful shutdown successful")
    process.exit(0)
  })
}


function setupSignals () {
  process.on("SIGHUP", restart)
  process.on("SIGINT", quit)
  process.on("SIGKILL", quitHard)
  process.on("exit", function () {
    if (!quitting) quitHard()
  })
}
