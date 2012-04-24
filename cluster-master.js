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

  // start it!
  restart()
}

function forkListener () {
  cluster.on("fork", function (worker) {
    worker.birth = Date.now()
    var id = worker.uniqueID
    console.error("Worker %j setting up", id)
    if (onmessage) worker.on("message", onmessage)
    var disconnectTimer

    worker.on("exit", function () {
      clearTimeout(disconnectTimer)

      if (!worker.suicide) {
        console.error("Worker %j exited abnormally", id)
        // don't respawn right away if it's a very fast failure.
        // otherwise server crashes are hard to detect from monitors.
        if (Date.now() - worker.birth < 2000) {
          console.error("Worker %j died too quickly, not respawning.", id)
          return
        }
      } else {
        console.error("Worker %j exited", id)
      }

      if (Object.keys(cluster.workers).length < clusterSize) {
        resize()
      }
    })

    worker.on("disconnect", function () {
      console.error("Worker %j disconnect", id)
      // give it 1 second to shut down gracefully, or kill
      disconnectTimer = setTimeout(function () {
        console.error("Worker %j, forcefully killing", id)
        worker.process.kill("SIGKILL")
      }, 2000)
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
  , reqs = clusterSize - current.length

  // if we're resizing, then just kill off a few.
  if (reqs !== 0) resize()

  // all the current workers, kill and then wait for a
  // new one to spawn before moving on.
  var i = 0
  graceful()
  function graceful () {
    if (i >= current.length) {
      console.error("graceful completion")
      restarting = false
      return cb && cb()
    }
    var id = current[i++]
    console.error("graceful shutdown %j", id)
    var worker = cluster.workers[id]
    if (!worker) return graceful()
    if (!quitting) {
      cluster.once("fork", graceful)
    } else {
      worker.on("exit", graceful)
    }
    worker.disconnect()
  }
}



function resize (n) {
  if (n >= 0) clusterSize = n
  var current = Object.keys(cluster.workers)
  , c = current.length
  , req = clusterSize - c

  if (c === clusterSize) return

  // make us have the right number of them.
  if (req > 0) while (req -- > 0) cluster.fork()
  else for (var i = clusterSize; i < c; i ++) {
    cluster.workers[current[i]].disconnect()
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
