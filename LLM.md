# Use of LLMs

Since this project is also a playground for me to experiment with the latest and greatest slop making technology, I’ve been using ChatGPT, Claude and Gemini for a while to get things done I’m not really interested working on.

However, none of these tools are being used purely in a “vibe code” way where I’m not reading the code. I usually end up adjusting it to my liking or sometimes even completely rewriting it.

## Components implemented with the support of LLMs

Where’s what these tools have worked on in big chunks and my experience:

| Component | Reason and experience |
|-|-|
| Sound subsystem | I refactored the code in the beginning on my own until I hit some strange `.wav` file related issues later, I’m lacking the interest in that format, so I asked Claude as well as Gemini Pro to fix certain issues by providing debug information and game assets having those issues. |
| Octree implementation | I couldn’t be bothered writing this on my own. |
| Menu widgets | That would have been the 10th or more time in my life me writing a widget system. Not interested in doing it again. Claude did a so-so good job, I already started cherrypicking the good parts. |
| Refactoring client and server | The original code contained huge files with no documentation and confusing code. I asked Claude to restructure the code under my guidance. It’s partially done, still not up to what I’ve been picturing, but it helped a lot to not making the situation worse. |
| Refactoring of loading models and rendering | The original code is not OOP at all, this is the best place to have it done right in a more flexible way. I asked Claude to refactor it, it also didn’t do a great job leveraging OOP, so eventually I did an overhaul there by myself too. |
| WebRTC implementation | WebRTC is a complex topic and I had almost no prior experience hands-on. Gemini Pro did a great job in extending the Network Subsystem and implementing the WebRTC data channels as well as the ICE dance using the master server. Though a lot of back and forth debugging was required to get it in a stable enough place, since the engine’s network subsystem can be confusing as well.
| WebRTC/WebSockets master server | Not interested in writing yet another WebSocket mini service, therefore Claude and Gemini wrote almost all the code for this. Had to adjust it a couple of times, because it made some strange assumptions.
| A* algorithm, merging waypoints | ChatGPT came up with the initial version of the A* algorithm in `Navigation`, I enhanced it with the Octree data structure, later together with ChatGPT I optimized the waypoint placement. ChatGPT did a great job tutoring me in linear algebra, specially working with vectors and planes. |
| PBR materials | I had zero prior knowledge on bump mapping and specular mapping. I had a loose idea, but lacked the in-depth knowledge on calculating tagents and bitangents. Together with Claude I managed to come up with a working prototype and slowly I extended its code base getting it production ready. |
| Vite | It was faster to get Claude setting up Vite for me than to read the documentation. It’s pretty much a vanilla setup adjusted for the engine-game-separation though. At a later point I used Claude Opus 4.6 to come up with a solution to support building browser as well as the dedicated server and having the ability of running dedicated as a regular script for development purposes. |
| Documentation | Some of the documentation has been created/updated/improved using Gemini. |
| `MSG` into `SzBuffer` refactor | Played around with Claude Opus 4.5 and tasked it to merge the old C-style `MSG` functions into `SzBuffer` and it was 99% on point and it actually due to the asserts a couple of bugs I fixed myself afterwards. |
| `PHS` and area portals | Tried out Claude Opus 4.6 to backport the ideas of portals and PHS from Quake 2+. It has been a long journey with lots of debugging and manual tweaking. Result: not working lol. |
| Protocol 15 | I changed the network protocol quite a lot in order to support larger maps, incremental updates etc. I broke demo playback by doing so. I asked Claude Opus 4.6 to bring Protocol 15 back just enough to have demo playback working again. It was again a 90/10 result. |
| WebGL 2 port | Claude Opus 4.6 is really excelling at coding, especially doing heavy leg work such as porting from WebGL 1 to WebGL 2. It would have taken me hours to get everything sorted out and optimized. |
| Pmove improvements | I did an 80% port of pmove.c from QuakeWorld, together with Claude Opus 4.6 I implemented Q1 and Q2 movement profiles as well as wired up the whole code with client-side prediction and some other shenanigans. |
| Brushlist implementation | Pmove works best with non-hull based data, Claude Opus 4.6 sketched out the brushlist based code, but it was not perfect, lots of fine tuning and manual debugging was required to get a decent result. |
| Unit Tests | GPT-5.4 is my guinea pig on this one. I asked it to write unit tests around server physics code so that this code is always solid and won’t contain nasty surprises. |
| TypeScript support and port | See https://github.com/quakeshack/engine/pull/8 for details. |
| SOLID_MESH support | I wanted polygon-based collision support. Both Claude 4.5 back then and now GPT 5.4 are doing a so-so job. Some rainy day I need to look into it myself. |
| fogged up water | The old way of using the volumentric fog was bugging out and while being on a hike I had the idea on redoing it. I decided to give Claude Code another try. It did actually quite a good job on it. The first attempt was a bit botched, I used 5.3-Codex through GitHub Copilot to fix it, but the second part was fixed by Claude Code in one go. Compared to what I was used to Claude Code really improved on its token burning. |
| Navigation mesh fixes | At some point when I tried out too many things at once a bug entered my navigation code and I lacked the motivation to get rid of it. I let Claude Code (through the cli, not the web frontend) to work on it so it could also run tests and repro code. It took almost three hours but it came back with a solid fix. |

## Conclusion

The concepts of 90s and 2000s rendering are well-known enough for LLMs to be trained on well, but the Quake engine clearly is not. LLMs know of certain idiosyncrasis, but they clearly lack the in-depth domain knowledge and writing code for this project is nowhere as convenient as compared to a straightforward React.js/node.js project.

In general it’s highly advised to provide clear instructions to LLMs, otherwise the output will be a hit or miss erring on the side of miss.
