
GAME=bsp38tests
BASE=bsp38-tests

BASEDIR := ../$(BASE)
GAMEDIR := .

MAPS := $(wildcard $(GAMEDIR)/maps/*.map)
BSP_FILES := $(MAPS:.map=.bsp)

TOOLS_DIR := ../../../tools/ericw-tools
QBSP := $(TOOLS_DIR)/qbsp
VIS := $(TOOLS_DIR)/vis
LIGHT := $(TOOLS_DIR)/light

FLAGS=-lowpriority

all: $(BSP_FILES)

# These are small hand-authored BSP38Loader test fixtures (see
# docs/bsp38-loader-progress.md), not real game content, so no wads/textures
# are expected to exist under $(BASEDIR) — qbsp/vis/light will warn about
# missing textures and the missing baseq2 palette, but still produce a valid
# Quake II BSP.
%.bsp: %.map
	$(QBSP) -basedir $(BASEDIR) -gamedir $(GAMEDIR) $(FLAGS) -bspx -bmodelcontents -q2bsp $<
	$(VIS) -basedir $(BASEDIR) -gamedir $(GAMEDIR) $(FLAGS) $<
	$(LIGHT) -basedir $(BASEDIR) -gamedir $(GAMEDIR) $(FLAGS) -bspx -bspxlux -wrnormals -lightgrid -lightgrid_dist 16 16 16 $<
	rm -f $*.log $*-vis.log $*-light.log $*.prt $*.ent $*.texinfo.json $*.content.json

clean:
	rm -f $(GAMEDIR)/maps/*.bsp
