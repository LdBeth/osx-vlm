/* -*- Mode: C; Tab-Width: 4 -*- */

#include "std.h"

#include "VLM_configuration.h"
#include "life_prototypes.h"
#include "world_tools.h"
#include "utilities.h"
#include "SystemComm.h"

#ifdef _C_EMULATOR_
#include "emulator.h"
#include "memory.h"
#else
#include "ivoryrep.h"
#endif
#include "spy.h"

#ifdef OS_OSF
#include <machine/fpu.h>
#else
#include <fenv.h>
#endif

#define MBToWords(MB) ((MB * 1024 * 1024) + 4)/5
#define WordsToMB(words) ((5 * words) + (1024 * 1024) - 1)/(1024 * 1024)

Boolean Trace = FALSE;
Boolean EnableIDS = FALSE;
Boolean TestFunction = FALSE;
static sigset_t terminationSignals;

extern void EnableLifeSupportTermination (void);

/* Termination is handled synchronously on this dedicated thread rather than in
   an async signal handler.  main() blocks terminationSignals in every thread
   (the mask is inherited by all threads it spawns), so SIGINT/SIGTERM/... are
   delivered only here, via sigwait.  Teardown therefore runs in an ordinary
   thread context -- it never interrupts a worker mid-X-call, so TerminateLife-
   Support can take XLock and close the display with normal locking. */

static void* TerminationThread (void* ignored)
{
#ifdef OS_LINUX
  char *answer = NULL;
  size_t answerSize = 0, *answerSize_p = &answerSize;
  ssize_t nRead;
#else
  char answer[BUFSIZ];
#endif
  int sig, confirmed;

  (void) ignored;

  /* This thread (not a Life Support worker) is allowed to run teardown. */
  EnableLifeSupportTermination ();

  for (;;)
    {
      if (sigwait (&terminationSignals, &sig) != 0)
        continue;

      confirmed = TRUE;
      if (EmbCommAreaPtr->guestStatus > StartedGuestStatus)
        {
          if (RunningGuestStatus == EmbCommAreaPtr->guestStatus)
            fprintf (stderr, "\nLisp is running!\n\n");
          else
            fprintf (stderr, "\nLisp was running!\n\n");

          fprintf (stderr, "If you exit, the current state of Lisp will be lost.\n");
          fprintf (stderr, "All information in its memory image (e.g., any modified editor\n");
          fprintf (stderr, "buffers) will be irretrievably lost.  Further, Lisp will abandon\n");
          fprintf (stderr, "any tasks it is performing for its clients.\n\n");

          fprintf (stderr, "Do you still wish to exit?  (yes or no) ");
          fflush (stderr);

          for (confirmed = -1; confirmed < 0; )
            {
#ifdef OS_LINUX
              nRead = getline (&answer, answerSize_p, stdin);
              if (nRead < 0)
                vpunt (NULL, "Unexpected EOF on standard input");
              answer[nRead - 1] = '\0';
#else
              if (NULL == gets (answer))
                vpunt (NULL, "Unexpected EOF on standard input");
#endif
              if (0 == strcmp (answer, "yes"))
                confirmed = TRUE;
              else if (0 == strcmp (answer, "no"))
                confirmed = FALSE;
              else
                {
                  fprintf (stderr, "Please answer 'yes' or 'no'.  ");
                  fflush (stderr);
                }
            }
        }

      if (!confirmed)
        continue;               /* user declined -- resume waiting */

      TerminateTracing ();
      TerminateSpy ();
      TerminateLifeSupport ();

      _exit (EXIT_SUCCESS);
    }

  return NULL;                  /* not reached */
}


int main (int argc, char** argv)
{
  VLMConfig config;
  pthread_t terminationThread;
  Integer worldImageSize, worldImageMB;
  char* message;
  int reason;

  /* Block the termination signals before any worker threads are created, so
     every thread inherits the mask and they are handled only by sigwait in
     TerminationThread. */
  sigemptyset (&terminationSignals);
  sigaddset (&terminationSignals, SIGINT);
  sigaddset (&terminationSignals, SIGTERM);
  sigaddset (&terminationSignals, SIGHUP);
  sigaddset (&terminationSignals, SIGQUIT);
  if (pthread_sigmask (SIG_BLOCK, &terminationSignals, NULL))
    vpunt (NULL, "Unable to block termination signals.");

  BuildConfiguration (&config, argc, argv);
#ifdef GENERA
  EnableIDS = config.enableIDS;
#endif

  TestFunction = config.testFunction;
  Trace = config.tracing.tracePOST;
  InitializeIvoryProcessor (MapVirtualAddressData (0), MapVirtualAddressTag (0));

  Trace = config.tracing.traceP;
  if (Trace) InitializeTracing (config.tracing.bufferSize, config.tracing.startPC,
                                config.tracing.stopPC, config.tracing.outputFile);

  if (InitializeLifeSupport (&config) < 0) exit (-1);

#if defined(OS_OSF)
  ieee_set_fp_control(IEEE_TRAP_ENABLE_INV +
                      IEEE_TRAP_ENABLE_DZE +
                      IEEE_TRAP_ENABLE_OVF +
                      IEEE_TRAP_ENABLE_UNF +
                      IEEE_TRAP_ENABLE_INE);

#elif defined(OS_LINUX)
#ifdef FE_NOMASK_ENV
  fesetenv (FE_NOMASK_ENV);
#else
  feenableexcept (FE_INEXACT | FE_DIVBYZERO | FE_UNDERFLOW | FE_OVERFLOW | FE_INVALID);
#endif

#elif defined(OS_DARWIN)
  /* TBD: -- Need an equivalent to: fesetenv (FE_NOMASK_ENV) */
#endif

  if (pthread_create (&terminationThread, NULL, TerminationThread, NULL))
    vpunt (NULL, "Unable to establish the termination handler thread.");

#ifdef IVERIFY
  EnsureVirtualAddressRange (0xF8000000L, 0x00100000L, FALSE);
#else
  worldImageSize = LoadWorld (&config);

#ifdef GENERA
  LoadVLMDebugger (&config);

  worldImageMB = WordsToMB (worldImageSize);
  if (worldImageMB > config.virtualMemory)
    vpunt (NULL, "World file %s won't fit within the requested virtual memory (%dMB)",
           config.worldPath, config.virtualMemory);
  if ((2 * worldImageMB) > config.virtualMemory)
    vwarn (NULL, "Only %dMB of virtual memory unused after loading world file %s\n",
           (config.virtualMemory - worldImageMB), config.worldPath);

  VirtualMemoryWrite (SystemCommSlotAddress (enableSysoutAtColdBoot),
                      EnableIDS ? processor->taddress : processor->niladdress);

  EmbCommAreaPtr->virtualMemorySize = MBToWords (config.virtualMemory);
  EmbCommAreaPtr->worldImageSize = worldImageSize;
#endif
#endif

  if (config.enableSpy) InitializeSpy (TRUE, config.diagnosticIPAddress.s_addr);

#ifdef AUTOSTART
  if (!IvoryProcessorSystemStartup (TRUE))
    vpunt (NULL, "Unable to start the VLM.");
#endif

  if (config.enableSpy) ReleaseSpyLock ();

  while (config.enableSpy ? TRUE : Runningp())
    {
      reason = InstructionSequencer ();
      if (reason)     
        {
          switch (reason)
            {
            case HaltReason_IllInstn:
              message = "Unimplemented instruction";
              break;
    
            case HaltReason_Halted:
              message = NULL;
              break;
              
            case HaltReason_SpyCalled:
              message = NULL;
              break;
              
            case HaltReason_FatalStackOverflow:
              message = "Stack overflow while not in emulator mode";
              break;
              
            case HaltReason_IllegalTrapVector:
              message = "Illegal trap vector contents";
              break;
              
            default:      
              message = "Halted for unknown reason";
            }
          if (message != NULL)
            vwarn (NULL, "%s at PC %08x (%s)", message, processor->epc >> 1,
                   (processor->epc & 1) ? "Odd" : "Even");
        }
#ifndef IVERIFY
      if (HaltReason_Halted == reason)
        break;
#endif
    }

  exit (EXIT_SUCCESS);
}
