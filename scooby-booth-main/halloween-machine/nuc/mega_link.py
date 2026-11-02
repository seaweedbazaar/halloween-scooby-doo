"""
MegaLink -- serial link between the NUC and the Arduino Mega (import this in the NUC app)

    pip install pyserial

Usage:
    from mega_link import MegaLink

    def on_event(name, args):
        print(name, args)     # e.g. ("START", []), ("CHAR", ["3"]), ("MODE", ["RED", "3"]), ("PRINT", [])

    mega = MegaLink(port=None, on_event=on_event)   # port=None = auto-detect the Mega
    mega.start()
    ...
    mega.arm()               # only needed if AUTO_ARM = false on the Mega: unlock the knife switch
    mega.progress(42)        # generate/print progress 0-100 (-1 = indeterminate flowing animation)
    mega.done()              # print finished
    mega.reset()             # force back to idle

on_event runs on a background thread. If your app is a GUI / game engine,
put events into a queue and handle them on the main thread.
"""

import threading
import time

import serial
import serial.tools.list_ports

BAUD = 115200
ACKED_COMMANDS = {"ARM", "DONE", "RESET"}


def find_mega_port():
    """Find the Arduino Mega (official VID 2341 / common clone CH340 1A86)."""
    candidates = []
    for p in serial.tools.list_ports.comports():
        desc = f"{p.description} {p.manufacturer or ''}".lower()
        if p.vid == 0x2341 or "mega" in desc or "arduino" in desc:
            candidates.insert(0, p.device)
        elif p.vid in (0x1A86, 0x0403, 0x10C4):   # CH340 / FTDI / CP210x
            candidates.append(p.device)
    return candidates[0] if candidates else None


class MegaLink:
    def __init__(self, port=None, on_event=None, verbose=False):
        self.port = port
        self.on_event = on_event or (lambda name, args: None)
        self.verbose = verbose
        self.ser = None
        self._stop = threading.Event()
        self._acks = {}
        self._lock = threading.Lock()
        self.ready = threading.Event()

    # ---------- connection ----------
    def start(self):
        port = self.port or find_mega_port()
        if not port:
            raise RuntimeError("Arduino Mega not found -- pass the port manually, e.g. port='COM5' or '/dev/cu.usbmodem1101'")
        self.ser = serial.Serial(port, BAUD, timeout=0.1)
        self.port = port
        threading.Thread(target=self._reader, daemon=True).start()
        # opening the port resets the Mega; wait for READY
        if not self.ready.wait(5):
            print("[MegaLink] No READY received, continuing (the Mega may already be running)")
        return self

    def close(self):
        self._stop.set()
        if self.ser:
            self.ser.close()

    # ---------- sending ----------
    def _write(self, line):
        with self._lock:
            self.ser.write((line + "\n").encode())
        if self.verbose:
            print(f"  → {line}")

    def send(self, cmd, retries=5, timeout=0.3):
        """Send a command. ARM / DONE / RESET wait for an ACK and are resent if none arrives."""
        if cmd not in ACKED_COMMANDS:
            self._write(cmd)
            return True
        ev = threading.Event()
        self._acks[cmd] = ev
        for _ in range(retries):
            self._write(cmd)
            if ev.wait(timeout):
                return True
        print(f"[MegaLink] No ACK for {cmd}")
        return False

    def arm(self):            return self.send("ARM")
    def done(self):           return self.send("DONE")
    def reset(self):          return self.send("RESET")
    def progress(self, pct):  return self.send(f"PROGRESS:{int(pct)}")
    def ping(self):           return self.send("PING")
    def calibrate(self, v):   return self.send(f"CAL:{int(v)}")

    # ---------- receiving ----------
    def _reader(self):
        buf = b""
        while not self._stop.is_set():
            try:
                buf += self.ser.read(256)
            except serial.SerialException as e:
                print(f"[MegaLink] Serial port error: {e}")
                time.sleep(1)
                continue
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode(errors="ignore").strip()
                if line:
                    self._handle(line)

    def _handle(self, line):
        if line.startswith("#"):              # debug message from the Mega
            if self.verbose:
                print(f"  [mega] {line[1:].strip()}")
            return
        if self.verbose:
            print(f"  ← {line}")
        parts = line.split(":")
        name, args = parts[0], parts[1:]
        if name == "ACK" and args:
            ev = self._acks.pop(args[0], None)
            if ev:
                ev.set()
            return
        if name == "READY":
            self.ready.set()
        self.on_event(name, args)