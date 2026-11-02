/*
  ===========================================================
   Halloween Machine - Interaction 1 - Arduino Mega 2560
  ===========================================================
  Libraries (Arduino IDE -> Tools -> Manage Libraries):
    - Adafruit MCP4728
    - Adafruit LED Backpack Library   (install its dependencies, incl. Adafruit GFX)
    - Adafruit NeoPixel

  Flow:
    IDLE --turn key (either way)--> SELECT --red/blue button--> ARMED
      ^   (NUC takes photo on START)  (knob picks character)        | knife switch (either way)
      |                                                              v
    DONE_ANIM <----------------- NUC sends DONE ------------------ PRINTING
                                         (NUC sends PROGRESS:0-100 -> LED strip)

  Until the knife switch, turning the knob after a button goes back to SELECT (CHAR:n is sent),
  and the other button switches the story (MODE is sent again).

  Serial: 115200 baud, one message per line. See README.md for the protocol.
*/

#include <Wire.h>
#include <Adafruit_MCP4728.h>
#include <Adafruit_GFX.h>
#include "Adafruit_LEDBackpack.h"
#include <Adafruit_NeoPixel.h>

// ================== Settings ==================

// ---- Pins ----
const uint8_t PIN_KEY      = 22;
const uint8_t PIN_RED      = 24;
const uint8_t PIN_BLUE     = 26;
const uint8_t PIN_SMALL[3] = {28, 30, 32};
const uint8_t PIN_KNIFE    = 34;
const uint8_t PIN_POT      = A0;
const uint8_t PIN_LED[5]   = {2, 3, 4, 5, 6};   // -> MOSFET board PWM inputs
const uint8_t PIN_STRIP    = 7;                 // -> LED strip DIN (optional 330 ohm resistor)

// ---- Character LEDs (via MOSFET boards) ----
const bool LED_ACTIVE_HIGH = true;   // set false if the LEDs are on/off the wrong way round

// ---- LED strip ----
const uint16_t STRIP_COUNT      = 32;    // number of LEDs actually used (WS2813)
const uint8_t  STRIP_BRIGHTNESS = 100;   // 0-255, limits current (100 = ~40%)
#define STRIP_TYPE (NEO_BRG + NEO_KHZ800) // maker says BRG; if not blue, try NEO_GRB / NEO_RGB
const bool STRIP_REVERSED = false;       // set true if the progress bar runs the wrong way
// Strip colors as 0xRRGGBB. Red and blue only show while that button is chosen.
const uint32_t COLOR_WORK = 0x78FF00;    // lime green: progress bar and done flash
const uint32_t COLOR_RED  = 0xFF0000;    // breathing while armed after the red button
const uint32_t COLOR_BLUE = 0x0000FF;    // breathing while armed after the blue button

// ---- Alphanumeric display (HT16K33) ----
const uint8_t NUM_ALPHA        = 1;      // 2 if using both (bridge A0 on the 2nd one -> 0x71)
const uint8_t ALPHA_ADDR[2]    = {0x70, 0x71};
const uint8_t ALPHA_BRIGHTNESS = 10;     // 0-15
// Words that randomly flash (4 characters each)
const char* WORDS[] = {"OPEN", "OPEN", "0PEN", "????", "BOO!", "HELP", "RUN ", "1031", "ERR ", "EYES"};
const uint8_t NUM_WORDS = sizeof(WORDS) / sizeof(WORDS[0]);

// ---- Potentiometer ----
const bool POT_REVERSED   = false;   // set true if left/right is reversed
const int  POT_HYSTERESIS = 25;      // prevents flicker at zone borders

// ---- Main meter DH-670 (0-5V): DAC value for each of the 5 positions (0-4095 = 0-5V) ----
// Use the serial command CAL:<value> to find the right values, then put them here
uint16_t MAIN_METER_POS[5] = {819, 1638, 2457, 3276, 4095};   // ~1 / 2 / 3 / 4 / 5 V
const uint16_t MAIN_METER_REST = 0;

// ---- Small meters SO-45 (0-3V): max must stay below 2457 (= 3V) ----
const uint16_t SMALL_METER_MAX = 2400;
const unsigned long SMALL_SWING_MS = 3000;   // how long the needle goes crazy after one press
const unsigned long SMALL_JUMP_MIN_MS = 70;  // jump interval: smaller = more frantic,
const unsigned long SMALL_JUMP_MAX_MS = 180; //   but too small and the needle just shivers in the middle

// ---- Flow ----
// true (current flow) = knife switch unlocks right after red/blue; false = wait for ARM from the NUC
const bool AUTO_ARM = true;
// The NUC app is in charge of timing: it asks STATE every few seconds, and while it does, the three timeouts
// below are switched off. The app sends RESET when its screen goes back to the start (and DONE when the card
// is out), so changing the timing in the app is enough. They only apply if the app goes quiet for HOST_SILENT_MS.
const unsigned long HOST_SILENT_MS     = 10000;
const unsigned long SESSION_TIMEOUT_MS = 120000;   // back to idle if nobody touches anything
const unsigned long PRINT_TIMEOUT_MS   = 120000;   // give up printing if the NUC goes silent
const unsigned long DONE_ANIM_MS       = 3000;     // strip flash length; afterwards stays in DONE_ANIM until RESET

// ================== Usually no need to change below ==================

struct Debounced {
  uint8_t pin; bool stable; bool raw; unsigned long changedAt; uint16_t ms;
  void begin(uint8_t p, uint16_t d) {
    pin = p; ms = d;
    pinMode(pin, INPUT_PULLUP);
    stable = raw = digitalRead(pin);
    changedAt = millis();
  }
  // returns true when the stable state changes
  bool update() {
    bool r = digitalRead(pin);
    if (r != raw) { raw = r; changedAt = millis(); }
    if (r != stable && millis() - changedAt >= ms) { stable = r; return true; }
    return false;
  }
  bool pressed() const { return stable == LOW; }
};

enum State : uint8_t { IDLE, SELECT, LOCKED, ARMED, PRINTING, DONE_ANIM };

Adafruit_MCP4728 dac;
bool dacOk = false;
uint16_t dacWritten[4] = {65535, 65535, 65535, 65535};

Adafruit_AlphaNum4 alpha[2];
bool alphaOk[2] = {false, false};

Adafruit_NeoPixel strip(STRIP_COUNT, PIN_STRIP, STRIP_TYPE);

Debounced keySw, knifeSw, redBtn, blueBtn, smallBtn[3];

State state = IDLE;
unsigned long stateSince = 0, lastActivity = 0, lastNucMsg = 0;
int potZone = 0;      // 0-4, current knob position
int charIdx = 0;      // 0-4, selected character
char chosenMode = 0;  // 'R' or 'B' once a button is chosen
int progress = -1;    // -1 = indeterminate (flowing animation), 0-100 = progress bar
int calValue = -1;    // main meter override during CAL

// ---------- Helpers ----------
const char* stateName(State s) {
  switch (s) {
    case IDLE: return "IDLE"; case SELECT: return "SELECT"; case LOCKED: return "LOCKED";
    case ARMED: return "ARMED"; case PRINTING: return "PRINTING"; case DONE_ANIM: return "DONE_ANIM";
  }
  return "?";
}

void sendEvent(const char* s) { Serial.println(s); }

// ================== Meters ==================
float mainCur = 0;
struct SmallMeter { uint16_t val; bool high; unsigned long until, nextJump; } smalls[3];
int smallTest = -1;   // SMALL:n test mode, -1 = off
unsigned long meterNext = 0;

void writeDac(uint8_t ch, uint16_t val) {
  if (!dacOk || dacWritten[ch] == val) return;
  dac.setChannelValue((MCP4728_channel_t)ch, val, MCP4728_VREF_VDD, MCP4728_GAIN_1X);
  dacWritten[ch] = val;
}

void updateMeters(unsigned long now) {
  if (now < meterNext) return;
  meterNext = now + 20;

  // Main meter: glides smoothly to the selected character's position
  uint16_t mainTarget;
  if (calValue >= 0) mainTarget = calValue;
  else if (state == IDLE) mainTarget = MAIN_METER_REST;
  else mainTarget = MAIN_METER_POS[charIdx];
  mainCur += (mainTarget - mainCur) * 0.15f;
  if (fabs(mainTarget - mainCur) < 2) mainCur = mainTarget;
  writeDac(0, (uint16_t)(mainCur + 0.5f));

  // Small meters: go crazy for a few seconds after their button is pressed
  for (uint8_t i = 0; i < 3; i++) {
    SmallMeter &m = smalls[i];
    if (smallTest >= 0) {
      m.val = smallTest;                       // SMALL:n test mode
    } else if (now < m.until) {
      if (now >= m.nextJump) {                 // slam between low and high
        m.high = !m.high;
        if (m.high && random(100) < 15) {      // sometimes pin to max and hold
          m.val = SMALL_METER_MAX;
          m.nextJump = now + random(250, 500);
        } else {
          m.val = m.high ? random(SMALL_METER_MAX * 6UL / 10, SMALL_METER_MAX + 1)
                         : random(0, SMALL_METER_MAX * 3UL / 10);
          m.nextJump = now + random(SMALL_JUMP_MIN_MS, SMALL_JUMP_MAX_MS);
        }
      }
    } else {
      m.val = 0;
    }
    writeDac(1 + i, min(m.val, SMALL_METER_MAX));
  }
}

// ================== Character LEDs ==================
void setLed(uint8_t i, bool on) {
  digitalWrite(PIN_LED[i], (on == LED_ACTIVE_HIGH) ? HIGH : LOW);
}

void updateLeds(unsigned long now) {
  for (uint8_t i = 0; i < 5; i++) {
    bool on;
    switch (state) {
      case IDLE:      on = (i == (now / 350) % 5); break;                    // idle: chase
      case ARMED:     on = (i == charIdx) && ((now / 300) % 2); break;      // blink: pull the switch
      case DONE_ANIM: on = (now - stateSince < DONE_ANIM_MS) ? (now / 150) % 2 : (i == charIdx); break; // all flash, then the chosen one
      default:        on = (i == charIdx); break;
    }
    setLed(i, on);
  }
}

// ================== Alphanumeric display ==================
unsigned long alphaNext = 0, alphaHoldUntil = 0;

void alphaWrite(const char* word) {
  for (uint8_t d = 0; d < NUM_ALPHA; d++) {
    if (!alphaOk[d]) continue;
    for (uint8_t i = 0; i < 4; i++) alpha[d].writeDigitAscii(i, word[i] ? word[i] : ' ');
    alpha[d].writeDisplay();
  }
}

void alphaShow(const char* word, unsigned long holdMs) {
  alphaWrite(word);
  alphaHoldUntil = millis() + holdMs;
}

void alphaGarble() {
  for (uint8_t d = 0; d < NUM_ALPHA; d++) {
    if (!alphaOk[d]) continue;
    for (uint8_t i = 0; i < 4; i++) {
      uint8_t r = random(10);
      if (r < 4)      alpha[d].writeDigitAscii(i, '0' + random(10));     // digit
      else if (r < 8) alpha[d].writeDigitRaw(i, random(0x4000));         // random segments
      else if (r < 9) alpha[d].writeDigitAscii(i, 'A' + random(26));     // letter
      else            alpha[d].writeDigitRaw(i, 0);                      // blank
    }
    alpha[d].writeDisplay();
  }
}

void updateAlpha(unsigned long now) {
  if (now < alphaHoldUntil || now < alphaNext) return;
  unsigned long interval = (state == IDLE) ? 180 : (state == PRINTING ? 60 : 100);
  if (random(100) < 6) alphaShow(WORDS[random(NUM_WORDS)], 700);
  else alphaGarble();
  alphaNext = now + interval;
}

// ================== LED strip (blue progress bar) ==================
unsigned long stripNext = 0;
State lastStripState = (State)255;
float dispProg = 0;
int lastLit = -1; uint8_t lastEdge = 0;

// Pixel i in the color c (0xRRGGBB) at brightness v (0-255)
void px(uint16_t i, uint8_t v, uint32_t c) {
  uint16_t idx = STRIP_REVERSED ? (STRIP_COUNT - 1 - i) : i;
  strip.setPixelColor(idx, ((c >> 16) & 0xFF) * v / 255, ((c >> 8) & 0xFF) * v / 255, (c & 0xFF) * v / 255);
}

// Note: strip.show() briefly disables interrupts, so serial bytes can be lost.
// We only call show() when the picture changes; important commands are ACKed and resent.
void updateStrip(unsigned long now) {
  if (now < stripNext) return;
  stripNext = now + 30;
  bool needShow = false;

  switch (state) {
    case PRINTING:
      if (progress < 0) {                       // indeterminate: comet
        const int TAIL = 24;
        int head = (now / 6) % (STRIP_COUNT + TAIL);
        for (uint16_t i = 0; i < STRIP_COUNT; i++) {
          int d = head - (int)i;
          px(i, (d >= 0 && d < TAIL) ? 255 - d * 10 : 0, COLOR_WORK);
        }
        needShow = true;
      } else {                                  // progress bar
        float target = progress * (float)STRIP_COUNT / 100.0f;
        dispProg += (target - dispProg) * 0.25f;
        if (fabs(target - dispProg) < 0.05f) dispProg = target;
        int lit = (int)dispProg;
        uint8_t edge = (uint8_t)((dispProg - lit) * 255);
        if (lit != lastLit || edge != lastEdge || lastStripState != state) {
          for (uint16_t i = 0; i < STRIP_COUNT; i++) px(i, i < lit ? 255 : (i == lit ? edge : 0), COLOR_WORK);
          lastLit = lit; lastEdge = edge;
          needShow = true;
        }
      }
      break;

    case ARMED: {                               // faint breathing in the chosen button's color: ready to pull
      uint32_t ph = (now - stateSince) % 2000UL;
      uint32_t tri = (ph < 1000UL) ? ph : 2000UL - ph;
      uint8_t v = 6 + (uint8_t)(tri * 40UL / 1000UL);
      uint32_t c = chosenMode == 'R' ? COLOR_RED : COLOR_BLUE;
      for (uint16_t i = 0; i < STRIP_COUNT; i++) px(i, v, c);
      needShow = true;
      break;
    }

    case DONE_ANIM: {                           // flash 3 times, then fade out
      unsigned long t = now - stateSince;
      uint8_t v;
      if (t < 900) v = ((t / 150) % 2) ? 0 : 255;
      else if (t < DONE_ANIM_MS) v = 255 - (uint8_t)((t - 900) * 255 / (DONE_ANIM_MS - 900));
      else v = 0;
      for (uint16_t i = 0; i < STRIP_COUNT; i++) px(i, v, COLOR_WORK);
      needShow = true;
      break;
    }

    default:
      if (lastStripState != state) { strip.clear(); needShow = true; }
      break;
  }

  if (needShow) strip.show();
  lastStripState = state;
}

// ================== State changes ==================
void setState(State s) {
  state = s;
  stateSince = lastActivity = millis();
  if (s == PRINTING) { progress = -1; dispProg = 0; lastLit = -1; }
  Serial.print("# state -> "); Serial.println(stateName(s));
}

void goIdle() {
  setState(IDLE);
  sendEvent("IDLE");
}

void startSession() {
  charIdx = potZone;
  chosenMode = 0;
  setState(SELECT);
  sendEvent("START");
  Serial.print("CHAR:"); Serial.println(charIdx + 1);
  alphaShow("OPEN", 1500);
}

void enterArmed() {
  setState(ARMED);
  sendEvent("ARMED");
  alphaShow("PULL", 1500);
}

// Works until the knife switch: the other button switches the story, the same one again does nothing
void chooseMode(const char* mode) {
  if (state != SELECT && state != LOCKED && state != ARMED) return;
  if (state != SELECT && mode[0] == chosenMode) return;
  chosenMode = mode[0];
  Serial.print("MODE:"); Serial.print(mode); Serial.print(':'); Serial.println(charIdx + 1);
  setState(LOCKED);
  alphaShow(mode[0] == 'R' ? "RED " : "BLUE", 1200);
  if (AUTO_ARM) enterArmed();
}

// ================== Potentiometer ==================
void updatePot() {
  int v = analogRead(PIN_POT);
  if (POT_REVERSED) v = 1023 - v;
  const int W = 1024 / 5;
  int z = v / W; if (z > 4) z = 4;
  if (z != potZone) {
    int lo = potZone * W, hi = lo + W;
    if (v < lo - POT_HYSTERESIS || v > hi + POT_HYSTERESIS) potZone = z;
  }
}

// ================== Serial commands (from the NUC) ==================
char rxBuf[48];
uint8_t rxLen = 0;

void ack(const char* cmd) { Serial.print("ACK:"); Serial.println(cmd); }

void handleCommand(char* cmd) {
  lastNucMsg = millis();

  if (!strcmp(cmd, "PING")) { Serial.println("PONG"); return; }
  if (!strcmp(cmd, "STATE")) { Serial.print("STATE:"); Serial.println(stateName(state)); return; }

  if (!strcmp(cmd, "ARM")) {
    ack(cmd);
    if (state == LOCKED) enterArmed();
    return;
  }
  if (!strncmp(cmd, "PROGRESS:", 9)) {
    if (state == PRINTING) progress = constrain(atoi(cmd + 9), -1, 100);
    return;
  }
  if (!strcmp(cmd, "DONE")) {
    ack(cmd);
    if (state == PRINTING || state == ARMED) { setState(DONE_ANIM); alphaShow("BOO!", 2000); }
    return;
  }
  if (!strcmp(cmd, "RESET")) {
    ack(cmd);
    goIdle();
    return;
  }
  if (!strncmp(cmd, "SMALL:", 6)) {        // hold all small meters: SMALL:2400, SMALL:-1 to stop
    int v = atoi(cmd + 6);
    smallTest = (v < 0) ? -1 : constrain(v, 0, SMALL_METER_MAX);
    Serial.print("# small meters = "); Serial.println(smallTest);
    return;
  }
  if (!strncmp(cmd, "CAL:", 4)) {          // calibrate main meter: CAL:2048, CAL:-1 to stop
    int v = atoi(cmd + 4);
    calValue = (v < 0) ? -1 : constrain(v, 0, 4095);
    Serial.print("# CAL main meter = "); Serial.println(calValue);
    return;
  }
  Serial.print("# unknown command: "); Serial.println(cmd);
}

void pollSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (rxLen) { rxBuf[rxLen] = 0; handleCommand(rxBuf); rxLen = 0; }
    } else if (rxLen < sizeof(rxBuf) - 1) {
      rxBuf[rxLen++] = toupper(c);
    } else {
      rxLen = 0;   // line too long, drop it
    }
  }
}

// ================== setup / loop ==================
void setup() {
  Serial.begin(115200);

  for (uint8_t i = 0; i < 5; i++) { pinMode(PIN_LED[i], OUTPUT); setLed(i, false); }

  keySw.begin(PIN_KEY, 50);
  knifeSw.begin(PIN_KNIFE, 80);
  redBtn.begin(PIN_RED, 30);
  blueBtn.begin(PIN_BLUE, 30);
  for (uint8_t i = 0; i < 3; i++) smallBtn[i].begin(PIN_SMALL[i], 30);

  randomSeed(analogRead(A15) ^ micros());

  Wire.begin();
  dacOk = dac.begin();
  if (!dacOk) Serial.println("# WARNING: MCP4728 not found");
  for (uint8_t d = 0; d < NUM_ALPHA; d++) {
    alphaOk[d] = alpha[d].begin(ALPHA_ADDR[d]);
    if (alphaOk[d]) { alpha[d].setBrightness(ALPHA_BRIGHTNESS); alpha[d].clear(); alpha[d].writeDisplay(); }
    else { Serial.print("# WARNING: alphanumeric display not found at 0x"); Serial.println(ALPHA_ADDR[d], HEX); }
  }
  Wire.setClock(400000);   // after all begin() calls
  for (uint8_t ch = 0; ch < 4; ch++) writeDac(ch, 0);

  strip.begin();
  strip.setBrightness(STRIP_BRIGHTNESS);
  strip.clear();
  strip.show();
  // Self-test: strip lights blue for 1 second at startup (if not, check the wiring)
  for (uint16_t i = 0; i < STRIP_COUNT; i++) strip.setPixelColor(i, 0, 0, 255);
  strip.show();
  delay(1000);
  strip.clear();
  strip.show();

  for (uint8_t i = 0; i < 8; i++) updatePot();   // read the knob position first
  stateSince = lastActivity = lastNucMsg = millis();
  sendEvent("READY");
}

void loop() {
  unsigned long now = millis();

  pollSerial();
  updatePot();

  // Key switch: any change starts a new session
  if (keySw.update()) {
    if (state == IDLE || state == DONE_ANIM) startSession();
    else Serial.println("# key ignored (session running)");
  }

  // Knife switch: only works when ARMED, any change counts
  if (knifeSw.update()) {
    if (state == ARMED) {
      sendEvent("PRINT");
      setState(PRINTING);
      alphaShow("WAIT", 1200);
    } else {
      Serial.println("# knife ignored (not armed)");
    }
  }

  if (redBtn.update() && redBtn.pressed())   chooseMode("RED");
  if (blueBtn.update() && blueBtn.pressed()) chooseMode("BLUE");

  // Three small buttons: work any time
  for (uint8_t i = 0; i < 3; i++) {
    if (smallBtn[i].update() && smallBtn[i].pressed()) {
      smalls[i].until = now + SMALL_SWING_MS;
      smalls[i].nextJump = now;
      lastActivity = now;
    }
  }

  // Character selection; turning the knob after a button cancels the choice (back to SELECT)
  if ((state == SELECT || state == LOCKED || state == ARMED) && potZone != charIdx) {
    charIdx = potZone;
    lastActivity = now;
    if (state != SELECT) { chosenMode = 0; setState(SELECT); }
    Serial.print("CHAR:"); Serial.println(charIdx + 1);
  }

  // Refresh the time: setState() above may have stored a time newer than 'now',
  // and now - stateSince would underflow to a huge number and trigger a false timeout
  now = millis();

  // Timeouts: only when the NUC app has gone quiet; otherwise its RESET decides (see HOST_SILENT_MS)
  bool hostAlive = (long)(now - lastNucMsg) < (long)HOST_SILENT_MS;
  if (!hostAlive) {
    if ((state == SELECT || state == LOCKED || state == ARMED) && now - lastActivity > SESSION_TIMEOUT_MS) {
      sendEvent("TIMEOUT");
      goIdle();
    }
    if (state == PRINTING && now - max(stateSince, lastNucMsg) > PRINT_TIMEOUT_MS) {
      sendEvent("TIMEOUT");
      goIdle();
    }
    if (state == DONE_ANIM && now - stateSince > DONE_ANIM_MS) goIdle();
  }

  updateLeds(now);
  updateMeters(now);
  updateAlpha(now);
  updateStrip(now);
}