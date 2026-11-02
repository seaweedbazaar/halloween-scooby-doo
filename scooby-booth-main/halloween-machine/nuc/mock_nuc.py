"""
Mock NUC -- run the whole hardware flow before the real NUC code is ready.

    pip install pyserial
    python mock_nuc.py                # auto-detect the Mega
    python mock_nuc.py COM5           # specify the port (Mac/Linux: /dev/cu.usbmodemXXXX)
    python mock_nuc.py -v             # verbose: show every serial message

Automatic flow:
    key -> [simulated photo] -> pick character -> red/blue -> pull knife switch
        -> [simulated generate + print, LED strip progress 0 -> 100] -> DONE

Commands you can type while it runs:
    arm / done / reset / ping / state
    p 50        set progress to 50
    cal 2048    calibrate main meter (cal -1 to stop)
    auto off / auto on   turn the automatic flow off/on (for manual testing)
    q           quit
"""

import sys
import threading
import time

from mega_link import MegaLink

CHARACTERS = ["Character 1", "Character 2", "Character 3", "Character 4", "Character 5"]
PHOTO_SECONDS = 3
PRINT_SECONDS = 15

auto = True
job_id = 0          # +1 every new session; old simulation threads stop themselves


def run_photo(mega, my_job):
    for i in range(PHOTO_SECONDS, 0, -1):
        if my_job != job_id:
            return
        print(f"   📷 Photo in {i}...")
        time.sleep(1)
    if my_job == job_id:
        print("   📷 Click! Photo taken")


def run_print(mega, my_job):
    steps = 50
    for i in range(steps + 1):
        if my_job != job_id:
            return
        pct = i * 100 // steps
        mega.progress(pct)
        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
        print(f"\r   🖨  Generating comic {bar} {pct:3d}%", end="", flush=True)
        time.sleep(PRINT_SECONDS / steps)
    print()
    if my_job == job_id:
        print("   🖨  Print finished -> sending DONE")
        mega.done()


def make_handler(mega_ref):
    def on_event(name, args):
        global job_id
        mega = mega_ref[0]
        if name == "READY":
            print("✅ Mega ready (idle -- turn the key to start)")
        elif name == "START":
            job_id += 1
            print("\n🔑 New session! Taking photo -- turn the knob to pick a character")
            if auto:
                threading.Thread(target=run_photo, args=(mega, job_id), daemon=True).start()
        elif name == "CHAR":
            i = int(args[0]) - 1
            print(f"   🎭 Character: {args[0]} {CHARACTERS[i] if 0 <= i < 5 else ''}")
        elif name == "MODE":
            mode, ch = args[0], args[1]
            print(f"   {'🔴' if mode == 'RED' else '🔵'} {mode} mode selected, character {ch}")
        elif name == "ARMED":
            print("   ⚡ Knife switch unlocked -- waiting for pull")
        elif name == "PRINT":
            print("   ⚡ Knife switch pulled!")
            if auto:
                threading.Thread(target=run_print, args=(mega, job_id), daemon=True).start()
        elif name == "TIMEOUT":
            job_id += 1
            print("   ⏱  Timeout -- Mega back to idle")
        elif name == "IDLE":
            print("💤 Idle")
        elif name in ("PONG", "STATE"):
            print(f"   {name} {' '.join(args)}")
        else:
            print(f"   (unknown event {name} {args})")
    return on_event


def main():
    global auto, job_id
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    port = args[0] if args else None
    ref = [None]
    mega = MegaLink(port=port, on_event=make_handler(ref), verbose="-v" in sys.argv)
    ref[0] = mega
    mega.start()
    print(f"Connected to {mega.port}. Type 'help' for commands.")

    while True:
        try:
            cmd = input().strip().lower()
        except (EOFError, KeyboardInterrupt):
            break
        if not cmd:
            continue
        if cmd in ("q", "quit", "exit"):
            break
        elif cmd == "help":
            print(__doc__)
        elif cmd == "arm":
            mega.arm()
        elif cmd == "done":
            job_id += 1
            mega.done()
        elif cmd == "reset":
            job_id += 1
            mega.reset()
        elif cmd == "ping":
            mega.ping()
        elif cmd == "state":
            mega.send("STATE")
        elif cmd.startswith("p "):
            mega.progress(int(cmd[2:]))
        elif cmd.startswith("cal "):
            mega.calibrate(int(cmd[4:]))
        elif cmd == "auto off":
            auto = False
            print("Automatic flow OFF")
        elif cmd == "auto on":
            auto = True
            print("Automatic flow ON")
        else:
            print("Unknown command -- type 'help'")
    mega.close()


if __name__ == "__main__":
    main()