# chaosd -- host-side Chaosnet station for the Portable Genera VLM.
# Plain POSIX make (BSD make and GNU make both work).

CC = cc
CFLAGS = -O2 -g -Wall -Wextra -Wno-deprecated-declarations
LDFLAGS =

CORE_OBJS = chaos-core.o chaos-stream.o netid.o
DAEMON_OBJS = chaosd.o vmnet-transport.o $(CORE_OBJS)
TEST_OBJS = chaosd-test.o $(CORE_OBJS)

all: chaosd chaosd-test

chaosd: $(DAEMON_OBJS)
	$(CC) $(LDFLAGS) -o chaosd $(DAEMON_OBJS) -framework vmnet

chaosd-test: $(TEST_OBJS)
	$(CC) $(LDFLAGS) -o chaosd-test $(TEST_OBJS)

test: chaosd-test
	./chaosd-test

chaos-core.o: chaos-core.c chaos-core.h
chaos-stream.o: chaos-stream.c chaos-stream.h chaos-core.h
netid.o: netid.c netid.h
vmnet-transport.o: vmnet-transport.c vmnet-transport.h netid.h
chaosd.o: chaosd.c chaos-core.h chaos-stream.h vmnet-transport.h
chaosd-test.o: chaosd-test.c chaos-core.h chaos-stream.h netid.h

clean:
	rm -f chaosd chaosd-test *.o

.PHONY: all test clean
