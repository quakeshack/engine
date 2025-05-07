# Client Server Architecture

## Client

Client side is really dumb. There is not much to it:

* render world and view model
* render visible entities
* render temporary entites
* render dynamlic lights
* demo playback
* connects to a server and parses messages
* collecting input data and sends them

### Connection State

Original Quake has two states to track the client:

1. connection state: disconnected, connecting, connected
1. signon number: 1, 2, 3, 4
    1. server data received, client sends prespawn, server sends signon message (baseline, statics), going to 2
    2. server baseline received, client sends name, color and spawn, server sends stats and lightstyle, going to 3
    3. server marked client as spawned
    4. only used by client, set to 4 when the first entity updates have been received

### Connection Main Loop

* Host._Frame
  * CL.ReadFromServer
    * CL.GetMessage
    * CL.ParseServerMessage
      * parses entity updates
      * handles Protocol.svc messages
    * CL.RelinkEntities
    * CL.UpdateTEnts

### New Infrastructure

CL.Init
CL.Connect(sock)
CL.Disconnect()
