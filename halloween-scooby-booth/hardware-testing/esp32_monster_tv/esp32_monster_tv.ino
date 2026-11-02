#define USE_SD false

#include <SPI.h>
#if USE_SD
#include <SD.h>
#endif
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#if !USE_SD
#include "monsters.h"
#endif

const int TFT_SCK  = 36;   // "SCK"
const int TFT_MOSI = 35;   // "MO"
const int TFT_CS   = 10;   // "10"
const int TFT_DC   = 9;    // "9"
const int TFT_RST  = 6;    // "6"
const int SD_SCK   = 14;   // "A4"
const int SD_MOSI  = 15;   // "A3"
const int SD_MISO  = 16;   // "A2"
const int SD_CS    = 17;   // "A1"
const int PIN_SWITCH = 12; // "12"

const bool SWITCH_ON_IS_LOW = true;
const uint8_t ROTATION      = 0;
const bool INVERT_COLORS    = false;
const bool RGB_ORDER        = false;
const char* IMAGE_DIR       = "/monsters";
const unsigned long SNOW_BURST_MS = 450;
const bool GLITCH_ON_IMAGE  = true;

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7796 _panel;
  lgfx::Bus_SPI _bus;
public:
  LGFX() {
    {
      auto cfg = _bus.config();
      cfg.spi_host    = SPI2_HOST;
      cfg.spi_mode    = 0;
      cfg.freq_write  = 40000000;
      cfg.freq_read   = 16000000;
      cfg.spi_3wire   = false;
      cfg.use_lock    = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk    = TFT_SCK;
      cfg.pin_mosi    = TFT_MOSI;
      cfg.pin_miso    = -1;
      cfg.pin_dc      = TFT_DC;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs        = TFT_CS;
      cfg.pin_rst       = TFT_RST;
      cfg.pin_busy      = -1;
      cfg.panel_width   = 320;
      cfg.panel_height  = 480;
      cfg.memory_width  = 320;
      cfg.memory_height = 480;
      cfg.offset_x = 0;
      cfg.offset_y = 0;
      cfg.offset_rotation = 0;
      cfg.readable   = false;
      cfg.invert     = INVERT_COLORS;
      cfg.rgb_order  = RGB_ORDER;
      cfg.dlen_16bit = false;
      cfg.bus_shared = false;
      _panel.config(cfg);
    }
    setPanel(&_panel);
  }
};

LGFX tft;
LGFX_Sprite frame(&tft);
bool frameOk = false;
const int W = 320, H = 480;
int imageCount = 0;
int lastImage = -1;

#if USE_SD
SPIClass sdSPI(HSPI);
bool sdOk = false;
String images[40];

void scanImages() {
  imageCount = 0;
  File dir = SD.open(IMAGE_DIR);
  if (!dir || !dir.isDirectory()) {
    Serial.printf("No %s folder on SD\n", IMAGE_DIR);
    return;
  }
  while (imageCount < 40) {
    File f = dir.openNextFile();
    if (!f) break;
    String name = f.name();
    String lower = name; lower.toLowerCase();
    if (!f.isDirectory() && !name.startsWith(".") && (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))) {
      images[imageCount++] = String(IMAGE_DIR) + "/" + name;
    }
    f.close();
  }
  dir.close();
  Serial.printf("Found %d images\n", imageCount);
}

void initImages() {
  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  sdOk = SD.begin(SD_CS, sdSPI, 20000000);
  if (!sdOk) sdOk = SD.begin(SD_CS, sdSPI, 4000000);
  Serial.printf("SD: %s\n", sdOk ? "OK" : "FAILED");
  if (sdOk) scanImages();
}

const char* imageError() { return sdOk ? "NO SIGNAL" : "NO SD CARD"; }

template <typename GFX>
void drawImage(GFX& g, int idx) {
  Serial.printf("Showing %s\n", images[idx].c_str());
  g.drawJpgFile(SD, images[idx].c_str(), 0, 0);
}

#else
void initImages() {
  imageCount = MONSTER_COUNT;
  Serial.printf("Built-in images: %d\n", imageCount);
}

const char* imageError() { return "NO SIGNAL"; }

template <typename GFX>
void drawImage(GFX& g, int idx) {
  Serial.printf("Showing built-in image %d\n", idx + 1);
  g.drawJpg(MONSTERS[idx], MONSTER_SIZES[idx], 0, 0);
}
#endif

static uint32_t rng = 0x12345678;
inline uint32_t xrand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }

uint16_t grayLUT[32];
uint16_t lineBuf[W * 2];
int rollY = 0;

void initSnow() {
  for (int i = 0; i < 32; i++) {
    uint8_t v = i * 255 / 31;
    grayLUT[i] = tft.color565(v, v, v);
  }
}

void drawSnowFrame() {
  rollY = (rollY + 7) % (H + 120);
  tft.startWrite();
  for (int y = 0; y < H; y += 2) {
    int bandDist = abs(y - (rollY - 60));
    int boost = bandDist < 60 ? (60 - bandDist) / 6 : 0;
    bool tear = (xrand() % 140) == 0;
    for (int x = 0; x < W; x += 2) {
      int v;
      if (tear) v = 24 + (xrand() & 7);
      else      v = (xrand() & 31) * 3 / 4 + boost;
      if (v > 31) v = 31;
      uint16_t c = grayLUT[v];
      lineBuf[x] = lineBuf[x + 1] = c;
      lineBuf[W + x] = lineBuf[W + x + 1] = c;
    }
    tft.pushImage(0, y, W, 2, lineBuf);
  }
  tft.endWrite();
}

void showRandomMonster() {
  if (imageCount == 0) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED);
    tft.setTextSize(3);
    tft.setTextDatum(textdatum_t::middle_center);
    tft.drawString(imageError(), W / 2, H / 2);
    return;
  }
  int idx = random(imageCount);
  if (imageCount > 1) while (idx == lastImage) idx = random(imageCount);
  lastImage = idx;

  if (frameOk) {
    frame.fillScreen(TFT_BLACK);
    drawImage(frame, idx);
    frame.pushSprite(0, 0);
  } else {
    drawImage(tft, idx);
  }
}

unsigned long nextGlitch = 0, glitchEnd = 0;

void updateGlitch(unsigned long now) {
  if (!frameOk || !GLITCH_ON_IMAGE) return;
  if (glitchEnd && now > glitchEnd) {
    frame.pushSprite(0, 0);
    glitchEnd = 0;
    nextGlitch = now + random(2500, 7000);
    return;
  }
  if (now < nextGlitch || glitchEnd) return;
  int bands = random(1, 4);
  for (int i = 0; i < bands; i++) {
    int y0 = random(H - 20), h = random(4, 28), dx = random(-24, 25);
    tft.setClipRect(0, y0, W, h);
    frame.pushSprite(dx, 0);
    tft.clearClipRect();
  }
  glitchEnd = now + random(80, 220);
}

bool readSwitchOn() {
  bool low = digitalRead(PIN_SWITCH) == LOW;
  return SWITCH_ON_IS_LOW ? low : !low;
}

bool switchOn = false;
bool rawOn = false;
unsigned long rawChanged = 0;

bool switchChanged(unsigned long now) {
  bool r = readSwitchOn();
  if (r != rawOn) { rawOn = r; rawChanged = now; }
  if (rawOn != switchOn && now - rawChanged > 40) { switchOn = rawOn; return true; }
  return false;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_SWITCH, INPUT_PULLUP);
  rng ^= esp_random();
  randomSeed(esp_random());

  tft.init();
  tft.setRotation(ROTATION);
  tft.fillScreen(TFT_BLACK);
  initSnow();

  frame.setPsram(true);
  frame.setColorDepth(16);
  frameOk = frame.createSprite(W, H) != nullptr;
  Serial.printf("PSRAM frame buffer: %s\n", frameOk ? "OK" : "not available (no glitch effect)");

  initImages();

  switchOn = rawOn = readSwitchOn();
  if (switchOn) showRandomMonster();
}

void loop() {
  unsigned long now = millis();

  if (switchChanged(now)) {
    if (switchOn) {
      unsigned long t0 = millis();
      while (millis() - t0 < SNOW_BURST_MS) drawSnowFrame();
      showRandomMonster();
      nextGlitch = millis() + random(2000, 5000);
      glitchEnd = 0;
    }
  }

  if (switchOn) {
    updateGlitch(now);
    delay(5);
  } else {
    drawSnowFrame();
  }
}
