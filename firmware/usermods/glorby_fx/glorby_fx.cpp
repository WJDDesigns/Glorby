// Glorby's sphere effects, running on the lamp itself.
//
// Ports of the effects in web/engine/effects.js (and core/effects.py), drawn from each
// triangle's 3D direction. They appear in WLED's effect list as "Glorby <name>", so the
// lamp plays them with no browser or Home Assistant attached, and presets keep them
// across restarts. Glorby's palettes are added to WLED's palette list as "Glorby: <name>".
//
// Settings map onto WLED's sliders. Each effect's metadata string names them, and the
// helper below turns a 0..255 slider into the effect's own range.
#include "wled.h"
#include "glorby_geo.h"

#ifndef TWO_PI
#define TWO_PI 6.283185307179586f
#endif

namespace glorby {

static constexpr int N = GLORBY_LEDS;
static const char PAL_OWNER[] PROGMEM = "Glorby";

// ---- small math -------------------------------------------------------------

static inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }
static inline float modf_(float a, float b) { float r = fmodf(a, b); return r < 0 ? r + b : r; }
static inline float smooth(float lo, float hi, float x) {
  float t = clampf((x - lo) / (hi - lo), 0.f, 1.f);
  return t * t * (3.f - 2.f * t);
}
static inline float dot3(const float *a, const float *b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static inline float angleTo(const float *p, const float *d) { return acosf(clampf(dot3(p, d), -1.f, 1.f)); }
static inline void unit3(float *v) {
  float n = sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (n < 1e-9f) n = 1e-9f;
  v[0] /= n; v[1] /= n; v[2] /= n;
}
static inline void cross3(const float *a, const float *b, float *o) {
  o[0] = a[1] * b[2] - a[2] * b[1];
  o[1] = a[2] * b[0] - a[0] * b[2];
  o[2] = a[0] * b[1] - a[1] * b[0];
}
static inline void dirLatLon(float latDeg, float lonDeg, float *o) {
  float la = latDeg * (PI / 180.f), lo = lonDeg * (PI / 180.f);
  o[0] = cosf(la) * cosf(lo); o[1] = cosf(la) * sinf(lo); o[2] = sinf(la);
}
static inline float frand() { return (hw_random() >> 8) * (1.0f / 16777216.0f); }
static inline float nrand() {  // standard normal
  float u = 1.f - frand();
  return sqrtf(-2.f * logf(u)) * cosf(TWO_PI * frand());
}
static inline void randomUnit(float *o) { o[0] = nrand(); o[1] = nrand(); o[2] = nrand(); unit3(o); }

static float LAT[N], LON[N];
static CRGBPalette16 RAINBOW;  // Glorby's Rainbow, filled in setup()

/** A slider (0..255) mapped onto lo..hi. */
static inline float slider(uint8_t v, float lo, float hi) { return lo + (hi - lo) * (v / 255.f); }
/** Speed as the web app has it: 0..4, 1 at the default slider position of 64. */
static inline float speedOf() { return SEGMENT.speed / 64.f; }

// ---- colours ----------------------------------------------------------------

struct RGBf { float r, g, b; };

static inline RGBf fromColor(uint32_t c) { return {R(c) / 255.f, G(c) / 255.f, B(c) / 255.f}; }

/** Palette lookup like palettes.sample(): wrap for cycling, clamp otherwise. */
static inline RGBf pal(float t, bool wrap) {
  if (!isfinite(t)) t = 0;
  uint32_t c;
  if (wrap) {
    t -= floorf(t);
    c = ColorFromPalette(SEGPALETTE, (unsigned)(t * 256.f) & 255, 255, LINEARBLEND);
  } else {
    c = ColorFromPalette(SEGPALETTE, (unsigned)(clampf(t, 0.f, 1.f) * 255.f), 255, LINEARBLEND_NOWRAP);
  }
  return fromColor(c);
}

/** A frame of float colours, written to the segment's matrix cells at the end. */
struct Frame {
  float c[N][3];
  void clear() { memset(c, 0, sizeof(c)); }
  void put(int i, float r, float g, float b) { c[i][0] = r; c[i][1] = g; c[i][2] = b; }
  void put(int i, const RGBf &v, float k = 1.f) { put(i, v.r * k, v.g * k, v.b * k); }
  void maxInto(int i, const RGBf &v, float k) {
    c[i][0] = fmaxf(c[i][0], v.r * k); c[i][1] = fmaxf(c[i][1], v.g * k); c[i][2] = fmaxf(c[i][2], v.b * k);
  }
  void fade(float k) { for (int i = 0; i < N; i++) for (int j = 0; j < 3; j++) c[i][j] *= k; }
};

static void show(const Frame &f) {
  const bool twoD = SEGMENT.is2D();
  const int w = SEG_W;
  SEGMENT.fill(BLACK);
  for (int i = 0; i < N; i++) {
    uint32_t col = RGBW32((uint8_t)(clampf(f.c[i][0], 0, 1) * 255.f + .5f),
                          (uint8_t)(clampf(f.c[i][1], 0, 1) * 255.f + .5f),
                          (uint8_t)(clampf(f.c[i][2], 0, 1) * 255.f + .5f), 0);
    const int cell = GEO_CELL[i];
    if (twoD) SEGMENT.setPixelColorXY(cell % w, cell / w, col);
    else if (cell < (int)SEGLEN) SEGMENT.setPixelColor(cell, col);
  }
}

/**
 * Every effect's state begins with this: its clock (seconds, scaled by speed), the
 * seconds since the last frame, and when that frame ran.
 */
struct Base {
  uint32_t last;
  float clock;
  float dt;
};

/** Allocates T in the segment's data and advances its clock. Null if out of memory. */
template <typename T> static T *begin(bool &fresh) {
  if (!SEGENV.allocateData(sizeof(T))) return nullptr;
  T *s = reinterpret_cast<T *>(SEGENV.data);
  fresh = SEGENV.call == 0;
  if (fresh) {
    memset(s, 0, sizeof(T));
    s->last = strip.now;
  }
  float dt = (strip.now - s->last) / 1000.f;
  s->last = strip.now;
  s->dt = clampf(dt, 0.f, 0.1f);
  s->clock += s->dt * speedOf();
  return s;
}

static void fallback() { SEGMENT.fill(SEGCOLOR(0)); }

// ---- Geometry ---------------------------------------------------------------

// Sweep: a soft band crossing the sphere.
static const char *const SWEEP_DIRS[] = {"Up and down", "Up", "Down", "Left", "Right"};
static constexpr float SWEEP_PASSES = 0.6f;

static float sweepAt(int i, int direction, float passes, float width) {
  float off;
  if (direction == 3 || direction == 4) {
    float center = TWO_PI * modf_(passes, 1.f) * (direction == 4 ? 1.f : -1.f);
    off = modf_(LON[i] - center + PI, TWO_PI) - PI;
  } else if (direction == 0) {
    float bounce = modf_(passes, 2.f);
    off = LAT[i] - (fminf(bounce, 2.f - bounce) * PI - PI / 2);
  } else {
    float margin = width * 1.5f;
    float center = modf_(passes, 1.f) * (PI + 2 * margin) - PI / 2 - margin;
    off = LAT[i] - (direction == 1 ? center : -center);
  }
  float x = off / width;
  return expf(-x * x);
}

struct SweepState : Base { float passes; Frame f; };
static void mode_sweep() {
  bool fresh;
  auto *s = begin<SweepState>(fresh);
  if (!s) return fallback();
  s->passes += s->dt * speedOf() * SWEEP_PASSES;
  const int dir = min(4, SEGMENT.custom1 / 52);
  const float width = slider(SEGMENT.intensity, 0.15f, 1.5f);
  const RGBf fg = fromColor(SEGCOLOR(0)), bg = fromColor(SEGCOLOR(1));
  for (int i = 0; i < N; i++) {
    float m = sweepAt(i, dir, s->passes, width);
    s->f.put(i, fg.r * m + bg.r * (1 - m), fg.g * m + bg.g * (1 - m), fg.b * m + bg.b * (1 - m));
  }
  show(s->f);
}
static const char _data_sweep[] PROGMEM =
    "Glorby Sweep@!,Width,Direction;Color,Background;;;sx=64,ix=66,c1=0";

// Plane Scanner: a plane tumbling through the sphere, leaving a trail.
struct TrailState : Base { Frame f; };
static void mode_scanner() {
  bool fresh;
  auto *s = begin<TrailState>(fresh);
  if (!s) return fallback();
  const float c = s->clock;
  float normal[3] = {sinf(c * 0.61f), cosf(c * 0.43f), sinf(c * 0.29f + 1)};
  unit3(normal);
  const float width = slider(SEGMENT.intensity, 0.08f, 0.8f);
  const float trail = slider(SEGMENT.custom1, 0.5f, 12.f);
  s->f.fade(expf(-s->dt * trail));
  for (int i = 0; i < N; i++) {
    float hit = 1 - smooth(0, width, fabsf(dot3(GEO_POS[i], normal)));
    s->f.maxInto(i, pal(c * 0.06f + (GEO_POS[i][2] + 1) * 0.12f, true), hit);
  }
  show(s->f);
}
static const char _data_scanner[] PROGMEM =
    "Glorby Plane Scanner@!,Width,Trail;;!;;sx=64,ix=60,c1=53";

// Comets: heads on great circles with fading tails.
struct CometState : Base { float axes[8][3]; Frame f; };
static void mode_comets() {
  bool fresh;
  auto *s = begin<CometState>(fresh);
  if (!s) return fallback();
  if (fresh) for (int k = 0; k < 8; k++) randomUnit(s->axes[k]);
  const int count = (int)slider(SEGMENT.custom1, 1, 8.99f);
  const float trail = slider(SEGMENT.intensity, 0.5f, 8.f);
  s->f.fade(expf(-s->dt * trail));
  static const float tilt[3] = {0.3f, 0.5f, 0.8f};
  for (int k = 0; k < count; k++) {
    float ref[3], other[3], head[3];
    cross3(s->axes[k], tilt, ref);
    unit3(ref);
    cross3(s->axes[k], ref, other);
    float a = s->clock * (1.1f + k * 0.13f) + k * 2.1f;
    for (int j = 0; j < 3; j++) head[j] = ref[j] * cosf(a) + other[j] * sinf(a);
    RGBf rgb = pal(k / 8.f + s->clock * 0.02f, true);
    for (int i = 0; i < N; i++) s->f.maxInto(i, rgb, 1 - smooth(0.12f, 0.42f, angleTo(GEO_POS[i], head)));
  }
  show(s->f);
}
static const char _data_comets[] PROGMEM =
    "Glorby Comets@!,Trail,Count;;!;;sx=64,ix=51,c1=73";

// Gyroscope: rings turning on different axes.
struct PlainState : Base { Frame f; };
static void mode_gyroscope() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const int rings = (int)slider(SEGMENT.custom1, 1, 5.99f);
  const float width = slider(SEGMENT.intensity, 0.08f, 0.5f);
  s->f.clear();
  for (int k = 0; k < rings; k++) {
    float c = s->clock * (0.6f + k * 0.23f) + k * 1.9f;
    float normal[3] = {sinf(c), cosf(c * 0.8f + k), sinf(c * 0.5f + k * 2)};
    unit3(normal);
    RGBf rgb = pal(0.3f + k / 6.f, true);
    for (int i = 0; i < N; i++) s->f.maxInto(i, rgb, 1 - smooth(0, width, fabsf(dot3(GEO_POS[i], normal))));
  }
  show(s->f);
}
static const char _data_gyroscope[] PROGMEM =
    "Glorby Gyroscope@!,Width,Rings;;!;;sx=64,ix=73,c1=102";

// Barber Spiral: palette stripes twisting round the sphere.
static void mode_spiral() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float arms = floorf(slider(SEGMENT.custom1, 1, 6.99f));
  const float twist = slider(SEGMENT.intensity, 0.f, 12.f);
  for (int i = 0; i < N; i++) {
    float phase = LON[i] * arms / TWO_PI + GEO_POS[i][2] * twist * 0.25f - s->clock * 0.4f;
    s->f.put(i, pal(phase, true));
  }
  show(s->f);
}
static const char _data_spiral[] PROGMEM =
    "Glorby Barber Spiral@!,Twist,Arms;;!;;sx=64,ix=85,c1=43";

// Interference: two wave sources beating against each other.
static void mode_interference() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float c = s->clock * 0.35f;
  float a[3] = {sinf(c), cosf(c * 0.7f), sinf(c * 0.4f)};
  float b[3] = {cosf(c * 0.9f), sinf(c * 1.2f), cosf(c * 0.5f)};
  unit3(a);
  unit3(b);
  const float k = slider(SEGMENT.intensity, 1.f, 8.f) * 2;
  for (int i = 0; i < N; i++) {
    float wave = sinf(angleTo(GEO_POS[i], a) * k - s->clock * 2) + sinf(angleTo(GEO_POS[i], b) * k - s->clock * 2);
    s->f.put(i, pal(wave * 0.25f + 0.5f, false));
  }
  show(s->f);
}
static const char _data_interference[] PROGMEM =
    "Glorby Interference@!,Rings;;!;;sx=64,ix=73";

// Polygon Dance: the 20 big faces lighting up one by one.
struct FacetState : Base { float colors[20], levels[20], next; Frame f; };
static void mode_facets() {
  bool fresh;
  auto *s = begin<FacetState>(fresh);
  if (!s) return fallback();
  if (fresh) for (int k = 0; k < 20; k++) { s->colors[k] = frand(); s->levels[k] = frand(); }
  const float hold = slider(SEGMENT.intensity, 0.1f, 3.f);
  if (s->clock > s->next) {
    int pick = hw_random(20);
    s->colors[pick] = frand();
    s->levels[pick] = 1;
    s->next = s->clock + hold * 0.25f;
  }
  const float decay = expf(-s->dt * speedOf() / fmaxf(hold, 0.1f));
  for (int k = 0; k < 20; k++) s->levels[k] *= decay;
  for (int i = 0; i < N; i++) {
    int face = GEO_PARENT[i];
    s->f.put(i, pal(s->colors[face], true), 0.08f + 0.92f * s->levels[face]);
  }
  show(s->f);
}
static const char _data_facets[] PROGMEM =
    "Glorby Polygon Dance@!,Hold;;!;;sx=64,ix=53";

// Pentagon Bloom: glows swelling from the 12 five-way corners.
static void mode_pentagons() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  float level[N] = {0};
  for (int k = 0; k < 12; k++) {
    float pulse = 0.5f + 0.5f * sinf(s->clock * 1.4f + k * 1.7f);
    for (int i = 0; i < N; i++)
      level[i] = fmaxf(level[i], pulse * (1 - smooth(0.2f, 0.75f, angleTo(GEO_POS[i], GEO_MAIN[k]))));
  }
  for (int i = 0; i < N; i++) s->f.put(i, pal(level[i], false));
  show(s->f);
}
static const char _data_pentagons[] PROGMEM = "Glorby Pentagon Bloom@!;;!;;sx=64";

// Life on a Sphere: a cellular automaton on the real triangle graph.
struct LifeState : Base { uint8_t alive[N]; float glow[N]; float next; uint32_t seen[8]; uint8_t seenCount; Frame f; };
static void lifeSeed(LifeState *s) {
  for (int i = 0; i < N; i++) s->alive[i] = frand() < 0.35f;
  s->seenCount = 0;
}
static uint32_t lifeSig(const uint8_t *a) {
  uint32_t h = 2166136261u;
  for (int i = 0; i < N; i++) h = (h ^ a[i]) * 16777619u;
  return h;
}
static void mode_life() {
  bool fresh;
  auto *s = begin<LifeState>(fresh);
  if (!s) return fallback();
  if (fresh) lifeSeed(s);
  if (s->clock > s->next) {
    s->next = s->clock + 0.35f;
    uint8_t was[N];
    memcpy(was, s->alive, N);
    bool any = false;
    for (int i = 0; i < N; i++) {
      int count = was[GEO_NEIGHBORS[i][0]] + was[GEO_NEIGHBORS[i][1]] + was[GEO_NEIGHBORS[i][2]];
      s->alive[i] = (was[i] && count == 1) || (!was[i] && count >= 2 && frand() < 0.5f);
      any |= s->alive[i];
    }
    uint32_t sig = lifeSig(s->alive);
    bool repeat = false;
    for (int k = 0; k < s->seenCount; k++) repeat |= s->seen[k] == sig;
    if (!any || repeat) {
      lifeSeed(s);
    } else {
      if (s->seenCount == 8) { memmove(s->seen, s->seen + 1, 7 * sizeof(uint32_t)); s->seenCount = 7; }
      s->seen[s->seenCount++] = sig;
    }
  }
  const float follow = fminf(1.f, s->dt * 6);
  for (int i = 0; i < N; i++) {
    s->glow[i] += (s->alive[i] - s->glow[i]) * follow;
    s->f.put(i, pal(s->glow[i] * 0.9f, false), s->glow[i]);
  }
  show(s->f);
}
static const char _data_life[] PROGMEM = "Glorby Life on a Sphere@!;;!;;sx=64";

// Snake: wanders from triangle to neighbouring triangle.
struct SnakeState : Base { uint8_t path[40]; uint8_t len; float next, hue; Frame f; };
static void mode_snake() {
  bool fresh;
  auto *s = begin<SnakeState>(fresh);
  if (!s) return fallback();
  if (fresh) { s->path[0] = 0; s->len = 1; }
  const int maxLen = (int)slider(SEGMENT.intensity, 3, 40.99f);
  if (s->clock > s->next) {
    s->next = s->clock + 0.11f;
    const uint8_t head = s->path[s->len - 1];
    uint8_t options[3];
    int n = 0;
    for (int j = 0; j < 3; j++) {
      uint8_t cand = GEO_NEIGHBORS[head][j];
      bool used = false;
      for (int k = 0; k < s->len; k++) used |= s->path[k] == cand;
      if (!used) options[n++] = cand;
    }
    uint8_t step = n ? options[hw_random(n)] : (uint8_t)hw_random(N);
    if (s->len < 40) s->path[s->len++] = step;
    else { memmove(s->path, s->path + 1, 39); s->path[39] = step; }
    if (s->len > maxLen) { memmove(s->path, s->path + (s->len - maxLen), maxLen); s->len = maxLen; }
    s->hue += 0.012f;
  }
  s->f.clear();
  for (int k = 0; k < s->len; k++) {
    float t = (k + 1) / (float)s->len;
    s->f.put(s->path[k], pal(s->hue + t * 0.2f, true), t * t);
  }
  show(s->f);
}
static const char _data_snake[] PROGMEM = "Glorby Snake@!,Length;;!;;sx=96,ix=48";

// Raindrops: rings spreading from random points.
struct Drop { float at[3]; float born; };
struct RainState : Base { Drop drops[10]; uint8_t count; float next; Frame f; };
static void mode_raindrops() {
  bool fresh;
  auto *s = begin<RainState>(fresh);
  if (!s) return fallback();
  const float rate = slider(SEGMENT.intensity, 0.1f, 5.f);
  if (s->clock > s->next) {
    if (s->count == 10) { memmove(s->drops, s->drops + 1, 9 * sizeof(Drop)); s->count = 9; }
    Drop &d = s->drops[s->count++];
    randomUnit(d.at);
    d.born = s->clock;
    s->next = s->clock - logf(1 - frand()) / rate;
  }
  int keep = 0;
  for (int k = 0; k < s->count; k++) if (s->clock - s->drops[k].born < 2.2f) s->drops[keep++] = s->drops[k];
  s->count = keep;
  for (int i = 0; i < N; i++) {
    float total = 0;
    for (int k = 0; k < s->count; k++) {
      float age = s->clock - s->drops[k].born;
      float x = (angleTo(GEO_POS[i], s->drops[k].at) - age * 1.6f) / 0.28f;
      total += expf(-x * x) * (1 - age / 2.2f);
    }
    s->f.put(i, pal(0.1f + total * 0.85f, false));
  }
  show(s->f);
}
static const char _data_raindrops[] PROGMEM = "Glorby Raindrops@!,Rate;;!;;sx=64,ix=47";

// Disco Ball: rainbow spots drifting over a dark base.
struct DiscoState : Base { float colors[12]; float offsets[12][2]; Frame f; };
static void mode_disco() {
  bool fresh;
  auto *s = begin<DiscoState>(fresh);
  if (!s) return fallback();
  if (fresh) for (int k = 0; k < 12; k++) { s->colors[k] = frand(); s->offsets[k][0] = frand() * 100; s->offsets[k][1] = frand() * 100; }
  const int spots = (int)slider(SEGMENT.custom1, 1, 12.99f);
  const RGBf base = fromColor(SEGCOLOR(1));
  for (int i = 0; i < N; i++) s->f.put(i, base);
  for (int k = 0; k < spots; k++) {
    float head[3];
    dirLatLon(50 * sinf(s->clock * 0.3f + s->offsets[k][0]), s->clock * 40 + s->offsets[k][1] * 3.6f, head);
    // The web version always takes the spots' colours from the Rainbow palette.
    RGBf col = fromColor(ColorFromPalette(RAINBOW, (unsigned)(s->colors[k] * 256.f) & 255, 255, LINEARBLEND));
    for (int i = 0; i < N; i++) s->f.maxInto(i, col, 1 - smooth(0.2f, 0.5f, angleTo(GEO_POS[i], head)));
  }
  show(s->f);
}
static const char _data_disco[] PROGMEM = "Glorby Disco Ball@!,,Spots;,Base;;;sx=64,c1=116";

// ---- palettes -----------------------------------------------------------------

struct PalDef { const char *name; uint8_t count; uint32_t stops[8]; };
static const char PN_AURORA[] PROGMEM = "Aurora", PN_EMBER[] PROGMEM = "Ember", PN_OCEAN[] PROGMEM = "Ocean",
                  PN_SUNSET[] PROGMEM = "Sunset", PN_NEON[] PROGMEM = "Neon", PN_RAINBOW[] PROGMEM = "Rainbow",
                  PN_ICE[] PROGMEM = "Ice", PN_FOREST[] PROGMEM = "Forest", PN_LAVA[] PROGMEM = "Lava",
                  PN_VAPOR[] PROGMEM = "Vaporwave", PN_ROYAL[] PROGMEM = "Royal", PN_CANDY[] PROGMEM = "Candy",
                  PN_MONO[] PROGMEM = "Mono", PN_BLOOD[] PROGMEM = "Blood", PN_TOXIC[] PROGMEM = "Toxic",
                  PN_HALLOWEEN[] PROGMEM = "Halloween";
// The same stops as web/engine/palettes.js.
static const PalDef PALETTES[] = {
  {PN_AURORA, 6, {0x031a2b, 0x0b6e4f, 0x21d59b, 0x7cf5c6, 0x7b3fe4, 0x150a3a}},
  {PN_EMBER, 6, {0x000000, 0x3a0500, 0xa31400, 0xff5a00, 0xffb300, 0xfff2b0}},
  {PN_OCEAN, 6, {0x00061a, 0x002a5c, 0x00639b, 0x00a6c7, 0x6fe7dd, 0xe6fffa}},
  {PN_SUNSET, 6, {0x1b0b3b, 0x5a1a77, 0xc2185b, 0xff5e3a, 0xffb347, 0xffe29f}},
  {PN_NEON, 6, {0xff00a8, 0x7a00ff, 0x00c8ff, 0x00ffb3, 0xfff000, 0xff00a8}},
  {PN_RAINBOW, 8, {0xff0000, 0xffb000, 0xb0ff00, 0x00ff40, 0x00ffff, 0x0040ff, 0xb000ff, 0xff0000}},
  {PN_ICE, 5, {0x000814, 0x023e8a, 0x0096c7, 0x90e0ef, 0xffffff}},
  {PN_FOREST, 5, {0x02120a, 0x0b3d20, 0x2d6a4f, 0x74c69d, 0xd8f3dc}},
  {PN_LAVA, 6, {0x000000, 0x240000, 0x8a0000, 0xff2a00, 0xff9500, 0xffe600}},
  {PN_VAPOR, 6, {0x2d00f7, 0x8900f2, 0xe500a4, 0xff5c8a, 0x00e5ff, 0x2d00f7}},
  {PN_ROYAL, 5, {0x07041f, 0x2a0a6b, 0x6a1fd0, 0xd4a017, 0xfff0b3}},
  {PN_CANDY, 6, {0xff5fa2, 0xffd166, 0x7cf29c, 0x6ecbff, 0xc58bff, 0xff5fa2}},
  {PN_MONO, 2, {0x000000, 0xffffff}},
  {PN_BLOOD, 4, {0x000000, 0x300000, 0xb00000, 0xff1a1a}},
  {PN_TOXIC, 5, {0x001200, 0x00471b, 0x39d353, 0xc6ff00, 0xf4ffb0}},
  {PN_HALLOWEEN, 5, {0x120016, 0x4b0082, 0xff6a00, 0xffae00, 0x3dff00}},
};

static CRGBPalette16 buildPalette(const PalDef &d) {
  CRGB e[16];
  const int last = d.count - 1;
  for (int i = 0; i < 16; i++) {
    float x = i / 15.f * last;
    int lo = min((int)x, last - 1);
    float f = x - lo;
    uint32_t a = d.stops[lo], b = d.stops[lo + 1];
    e[i] = CRGB((uint8_t)(((a >> 16) & 255) * (1 - f) + ((b >> 16) & 255) * f),
                (uint8_t)(((a >> 8) & 255) * (1 - f) + ((b >> 8) & 255) * f),
                (uint8_t)((a & 255) * (1 - f) + (b & 255) * f));
  }
  return CRGBPalette16(e);
}

}  // namespace glorby

class GlorbyFx : public Usermod {
 public:
  void setup() override {
    using namespace glorby;
    for (int i = 0; i < N; i++) {
      LAT[i] = asinf(clampf(GEO_POS[i][2], -1, 1));
      LON[i] = atan2f(GEO_POS[i][1], GEO_POS[i][0]);
    }
    strip.addEffect(255, &mode_sweep, _data_sweep);
    strip.addEffect(255, &mode_scanner, _data_scanner);
    strip.addEffect(255, &mode_comets, _data_comets);
    strip.addEffect(255, &mode_gyroscope, _data_gyroscope);
    strip.addEffect(255, &mode_spiral, _data_spiral);
    strip.addEffect(255, &mode_interference, _data_interference);
    strip.addEffect(255, &mode_facets, _data_facets);
    strip.addEffect(255, &mode_pentagons, _data_pentagons);
    strip.addEffect(255, &mode_life, _data_life);
    strip.addEffect(255, &mode_snake, _data_snake);
    strip.addEffect(255, &mode_raindrops, _data_raindrops);
    strip.addEffect(255, &mode_disco, _data_disco);

    RAINBOW = buildPalette(PALETTES[5]);
    removeUsermodPalettes(PAL_OWNER);
    uint8_t idx = 0;
    for (const PalDef &d : PALETTES) {
      if (usermodPalettes.size() >= WLED_MAX_USERMOD_PALETTES) break;
      usermodPalettes.push_back({buildPalette(d), PAL_OWNER, idx++, d.name});
    }
  }

  void addToJsonInfo(JsonObject &root) override {
    JsonObject g = root.createNestedObject(F("glorbyfx"));
    g[F("effects")] = 12;
    g[F("palettes")] = sizeof(glorby::PALETTES) / sizeof(glorby::PALETTES[0]);
  }

  uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }
};

static GlorbyFx glorby_fx;
REGISTER_USERMOD(glorby_fx);
