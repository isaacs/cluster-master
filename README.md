# cluster-master

A module for taking advantage of the built-in `cluster` module in node
v0.8 and above.

Your main `server.js` file uses this module to fire up a cluster of
workers.  Those workers then do the actual server stuff (using socket.io,
express, tako, raw node, whatever; any TCP/TLS/HTTP/HTTPS server would
work.)

This module provides some basic functionality to keep a server running.
As the name implies, it should only be run in the master module, not in
any cluster workers.

```javascript
var clusterMaster = require("cluster-master")

// most basic usage: just specify the worker
// Spins up as many workers as you have CPUs
//
// Note that this is VERY WRONG for a lot of multi-tenanted
// VPS environments where you may have 32 CPUs but only a
// 256MB RSS cap or something.
clusterMaster("worker.js")

// more advanced usage.  Specify configs.
// in real life, you can only actually call clusterMaster() once.
clusterMaster({ exec: "worker.js" // script to run
              , size: 5 // number of workers
              , env: { SOME: "environment_vars" }
              , args: [ "--deep", "doop" ]
              , silent: true
              , signals: false
              , onMessage: function (msg) {
                  console.error("Message from %s %j"
                               , this.uniqueID
                               , msg)
                }
              })

// methods
clusterMaster.resize(10)

// graceful rolling restart
clusterMaster.restart()

// graceful shutdown
clusterMaster.quit()

// not so graceful shutdown
clusterMaster.quitHard()
```

## Methods

### clusterMaster.resize(n)

Set the cluster size to `n`.  This will disconnect extra nodes and/or
spin up new nodes, as needed.  Done by default on restarts.

### clusterMaster.restart(cb)

One by one, shut down nodes and spin up new ones.  Callback is called
when finished.

### clusterMaster.quit()

Gracefully shut down the worker nodes and then process.exit(0).

### clusterMaster.quitHard()

Forcibly shut down the worker nodes and then process.exit(1).

## Configs

The `exec`, `env`, `argv`, and `silent` configs are passed to the
`cluster.fork()` call directly, and have the same meaning.

* `exec` - The worker script to run
* `env` - Envs to provide to workers
* `argv` - Additional args to pass to workers.
* `silent` - Boolean, default=false.  Do not share stdout/stderr
* `size` - Starting cluster size.  Default = CPU count
* `signals` - Boolean, default=true.  Set up listeners to:
  * `SIGHUP` - restart
  * `SIGINT` - quit
  * `SIGKILL` - quitHard
* `onMessage` - Method that gets called when workers send a message to
  the parent.  Called in the context of the worker, so you can reply by
  looking at `this`.

