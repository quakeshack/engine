# QuakeJS Game Code

In general the game code is completely object-oriented and it has *no global state*, therefore we need to carry around both engine interface as well as game interface. This allows the dedicated server to handle multiple servers at the same time enabling dynamic game lobbies etc.

## QuakeJS Game

Right now QuakeJS is a clean reimplementation of the Quake game logic.
It might not be perfect though, some idiosyncrasis will be sorted out as part of the code restructuring.

## Core concepts

### Files

The `main.mjs` file defines the entrypoint of the game. It will export the `GameAPI` class.

### Edict

The server keeps a list of things in the world in a structure called an Edict.

Edicts will hold information such as position, orientation, velocity etc.

### Entities

An Entity is sitting on top of an Edict. The Entity class will provide logic and keeps track of states. There are also client entities which are not related to these Entity structures.

### Frame Lifecyle

The server has to run every edict and entity

## Engine Interface

## Game Interface (GameAPI)


