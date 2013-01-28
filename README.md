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
* `onMessage` - Method that gets called when workers send a message to
  the parent.  Called in the context of the worker, so you can reply by
  looking at `this`.
* `repl` - where to have REPL listen, defaults to `env.CLUSTER_MASTER_REPL` || 'cluster-master-socket'
  * if `repl` is null or false - REPL is disabled and will not be started
  * if `repl` is string path - REPL will listen on unix domain socket to this path
  * if `repl` is an integer port - REPL will listen on TCP 0.0.0.0:port
  * if `repl` is an object with `address` and `port`, then REPL will listen on TCP address:PORT

Examples of configuring `repl`

```javascript
var config = { repl: false }                       // disable REPL
var config = { repl: '/tmp/cluster-master-sock' }  // unix domain socket
var config = { repl: 3001 }                        // tcp socket 0.0.0.0:3001
var config = { repl: { address: '127.0.0.1', port: 3002 }}  // tcp 127.0.0.1:3002
```

Note: be careful when using TCP for your REPL since anyone on the
network can connect to your REPL (no security). So either disable
the REPL or use a unix domain socket which requires local access
(or ssh access) to the server.

## REPL

Cluster-master provides a REPL into the master process so you can inspect
the state of your cluster. By default the REPL is accessible by a socket
written to the root of the directory, but you can override it with the
`CLUSTER_MASTER_REPL` environment variable. You can access the REPL with
nc or [socat](http://www.dest-unreach.org/socat/) like so:


```bash
nc -U ./cluster-master-socket

# OR

socat ./cluster-master-socket stdin
```

The REPL provides you with access to these objects or functions:

* `help`        - display these commands
* `repl`        - access the REPL
* `resize(n)`   - resize the cluster to `n` workers
* `restart(cb)` - gracefully restart workers, cb is optional
* `stop()`      - gracefully stop workers and master
* `kill()`      - forcefully kill workers and master
* `cluster`     - node.js cluster module
* `size`        - current cluster size
* `connections` - number of REPL connections to master
* `workers`     - current workers
* `select(fld)` - map of id to `field` (from workers)
* `pids`        - map of id to pids
* `ages`        - map of id to worker ages
* `states`      - map of id to worker states
* `debug(a1)`   - output `a1` to stdout and all REPLs
* `sock`        - this REPL socket'
* `.exit`       - close this connection to the REPL

