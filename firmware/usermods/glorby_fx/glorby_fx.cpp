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
static inline float uniform(float lo, float hi) { return lo + (hi - lo) * frand(); }
static inline void randomUnit(float *o) { o[0] = nrand(); o[1] = nrand(); o[2] = nrand(); unit3(o); }


// Gradient noise, the same tables and maths as sphere.js, so effects match the web app.
static inline float fadeN(float f) { return f * f * f * (f * (f * 6 - 15) + 10); }
static float noise3(float x, float y, float z) {
  const float fx0 = floorf(x), fy0 = floorf(y), fz0 = floorf(z);
  const float fx = x - fx0, fy = y - fy0, fz = z - fz0;
  const float ux = fadeN(fx), uy = fadeN(fy), uz = fadeN(fz);
  const int cx = (int)fx0 & 255, cy = (int)fy0 & 255, cz = (int)fz0 & 255;
  float out = 0;
  for (int dx = 0; dx < 2; dx++) {
    const float wx = dx ? ux : 1 - ux;
    const int px = NOISE_PERM[(cx + dx) & 255];
    for (int dy = 0; dy < 2; dy++) {
      const float wy = dy ? uy : 1 - uy;
      const int py = NOISE_PERM[(px + cy + dy) & 255];
      for (int dz = 0; dz < 2; dz++) {
        const float wz = dz ? uz : 1 - uz;
        const float *g = NOISE_GRAD[NOISE_PERM[(py + cz + dz) & 255]];
        out += wx * wy * wz * (g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz));
      }
    }
  }
  return out * 1.9f;
}
static float fbm(float x, float y, float z, int octaves = 3) {
  float total = 0, amp = 1, norm = 0;
  for (int i = 0; i < octaves; i++) {
    total += noise3(x, y, z) * amp;
    norm += amp;
    amp *= 0.5f;
    x = x * 2.03f + 11.7f;
    y = y * 2.03f + 11.7f;
    z = z * 2.03f + 11.7f;
  }
  return total / norm;
}

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
  float clock;  // seconds, scaled by the speed slider
  float dt;     // seconds since the last frame
  float t;      // seconds since the effect started, unscaled
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
  s->t += s->dt;
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


// ---- views and time -----------------------------------------------------------

/** Each triangle seen from the front: forward, right, up, turned by the facing angle. */
struct View { float forward[N], right[N], up[N]; };
static void makeView(View &v, float facingDeg, float dRight = 0, float dUp = 0) {
  float a = facingDeg * (PI / 180.f), c = cosf(a), sn = sinf(a);
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], y = GEO_POS[i][1];
    v.forward[i] = x * c + y * sn;
    v.right[i] = -x * sn + y * c + dRight;
    v.up[i] = GEO_POS[i][2] - dUp;
  }
}
/** Marks the one triangle nearest each (right, up) point, so features stay crisp. */
static void nearestMarks(const View &v, const float (*pts)[2], int count, uint8_t *mask) {
  memset(mask, 0, N);
  for (int k = 0; k < count; k++) {
    float r = pts[k][0], u = pts[k][1], f = sqrtf(fmaxf(0.f, 1 - r * r - u * u));
    int best = 0;
    float bestScore = -1e9f;
    for (int i = 0; i < N; i++) {
      float score = v.forward[i] * f + v.right[i] * r + v.up[i] * u;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    mask[best] = 1;
  }
}
/** Facing in degrees from the custom2 slider (128 = straight ahead). */
static inline float facingOf() { return (SEGMENT.custom2 - 128) * (180.f / 128.f); }

static bool timeKnown() { return toki.getTimeSource() != TOKI_TS_NONE; }

/** Where the sun is overhead right now, [lat, lon] in degrees. */
static void subsolar(float &lat, float &lon) {
  uint32_t now = toki.second();
  uint32_t daySec = now % 86400;
  // Day of the year, from days since 1970 (good enough for a lamp).
  time_t tt = now;
  struct tm g;
  gmtime_r(&tt, &g);
  int day = g.tm_yday + 1;
  float hours = daySec / 3600.f;
  lat = -23.44f * cosf((360.f / 365.f) * (day + 10) * (PI / 180.f));
  lon = (12 - hours) * 15;
}
/** 0 is new moon, 0.5 full. */
static float moonPhaseNow() {
  const double newMoon = 947182440.0;  // 2000-01-06 18:14 UTC
  double days = (toki.second() - newMoon) / 86400.0;
  double ph = fmod(days / 29.530588, 1.0);
  return (float)(ph < 0 ? ph + 1 : ph);
}

// ---- Worlds -------------------------------------------------------------------

struct Land { float lat, lon, radius; };
static const Land LAND[] = {
  {48, -100, 27}, {24, -100, 11}, {64, -125, 16}, {15, -86, 6},
  {-12, -58, 20}, {-34, -66, 10}, {6, -70, 9},
  {6, 21, 22}, {24, 12, 17}, {-22, 25, 12}, {8, 40, 8},
  {50, 15, 12}, {62, 25, 9},
  {52, 95, 30}, {24, 80, 11}, {24, 108, 12}, {66, 110, 16}, {36, 55, 10}, {-2, 115, 7},
  {-25, 134, 12}, {72, -40, 9},
};
static constexpr int LANDS = sizeof(LAND) / sizeof(LAND[0]);
static float LAND_AT[LANDS][3];

// Earth: continents, ice, clouds, real daylight and city lights at night.
struct SpinState : Base { float turn; Frame f; };
static void mode_earth() {
  bool fresh;
  auto *s = begin<SpinState>(fresh);
  if (!s) return fallback();
  const float spin = slider(SEGMENT.speed, -6.f, 6.f);
  const float night = SEGMENT.intensity / 255.f;
  s->turn += s->dt * spin * 0.15f;
  const float cosT = cosf(s->turn), sinT = sinf(s->turn);
  float subLat = 15, subLon = s->t * 0.1f * (180.f / PI);
  if (SEGMENT.check1 && timeKnown()) subsolar(subLat, subLon);
  float sun[3];
  dirLatLon(subLat, subLon, sun);
  static const float sea[3] = {0, 0.14f, 0.55f}, ground[3] = {0.08f, 0.5f, 0.12f}, desert[3] = {0.72f, 0.5f, 0.16f},
                     dark[3] = {0, 0.01f, 0.05f}, glow[3] = {1, 0.65f, 0.25f};
  for (int i = 0; i < N; i++) {
    const float px = GEO_POS[i][0], py = GEO_POS[i][1], pz = GEO_POS[i][2];
    float p[3] = {px * cosT + py * sinT, -px * sinT + py * cosT, pz};
    float land = 0;
    for (int k = 0; k < LANDS; k++)
      land = fmaxf(land, 1 - smooth(LAND[k].radius * 0.7f, LAND[k].radius * 1.15f, angleTo(p, LAND_AT[k]) * (180.f / PI)));
    float ice = smooth(62, 76, fabsf(asinf(clampf(p[2], -1, 1)) * (180.f / PI)));
    float latAbs = fabsf(p[2]);
    float dry = smooth(0.15f, 0.3f, latAbs) * (1 - smooth(0.4f, 0.6f, latAbs));
    float clouds = smooth(0.2f, 0.55f, fbm(p[0] * 2.2f + s->t * 0.03f, p[1] * 2.2f, p[2] * 2.2f, 2));
    float day = smooth(-0.12f, 0.2f, dot3(p, sun));
    float cities = land * (1 - day) * night * (0.6f + 0.4f * noise3(p[0] * 7, p[1] * 7, p[2] * 7));
    float o[3];
    for (int c = 0; c < 3; c++) {
      float v = (ground[c] * (1 - dry) + desert[c] * dry) * land + sea[c] * (1 - land);
      v = v * (1 - ice) + ice * 0.95f;
      v = v * (1 - clouds * 0.6f) + clouds * 0.6f;
      o[c] = v * (0.04f + 0.96f * day) + dark[c] * (1 - day) + cities * glow[c];
    }
    s->f.put(i, o[0], o[1], o[2]);
  }
  show(s->f);
}
static const char _data_earth[] PROGMEM = "Glorby Earth@Spin,Night glow,,,,Real daylight;;;;sx=149,ix=89,o1=1";

// Moon: tonight's phase, or one you choose.
static void mode_moon() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  static View v;
  makeView(v, facingOf());
  const float phase = (SEGMENT.check1 && timeKnown()) ? moonPhaseNow() : SEGMENT.custom1 / 255.f;
  const float a = phase * TWO_PI;
  const float shine = slider(SEGMENT.intensity, 0.f, 0.3f);
  for (int i = 0; i < N; i++) {
    const float *p = GEO_POS[i];
    float lit = smooth(-0.1f, 0.1f, v.forward[i] * -cosf(a) + v.right[i] * sinf(a));
    float surface = clampf(0.62f + 0.38f * fbm(p[0] * 2.6f, p[1] * 2.6f, p[2] * 2.6f, 3), 0, 1);
    float k = surface * (shine + (1 - shine) * lit);
    s->f.put(i, k, k * 0.97f, k * 0.88f);
  }
  show(s->f);
}
static const char _data_moon[] PROGMEM = "Glorby Moon@,Earthshine,Phase,Facing,,Tonight's phase;;;;ix=51,c1=128,c2=128,o1=1";

// Sun: a churning surface with flares.
static CRGBPalette16 EMBER;  // filled in setup()
static void mode_sun() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float activity = SEGMENT.intensity / 255.f;
  const float c = s->clock;
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], y = GEO_POS[i][1], z = GEO_POS[i][2];
    float heat = clampf(0.5f + 1.1f * fbm(x * 2.4f, y * 2.4f, z * 2.4f + c * 0.25f, 3), 0, 1);
    float flare = smooth(0.62f - activity * 0.3f, 0.9f, 0.5f + 0.5f * noise3(x * 1.6f + c * 0.4f, y * 1.6f + c * 0.4f, z * 1.6f + c * 0.4f));
    float t = clampf(0.38f + 0.42f * heat + 0.25f * flare, 0, 1);
    s->f.put(i, fromColor(ColorFromPalette(EMBER, (unsigned)(t * 255), 255, LINEARBLEND_NOWRAP)));
  }
  show(s->f);
}
static const char _data_sun[] PROGMEM = "Glorby Sun@!,Activity;;;;sx=64,ix=128";

// Jupiter: banded clouds and the great red spot.
static void mode_jupiter() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float turn = s->clock * 0.25f, c = cosf(turn), sn = sinf(turn);
  static const float light[3] = {0.95f, 0.82f, 0.6f}, dark[3] = {0.55f, 0.26f, 0.1f}, red[3] = {0.85f, 0.12f, 0.03f};
  float spotAt[3];
  dirLatLon(-22, 0, spotAt);
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], y = GEO_POS[i][1], z = GEO_POS[i][2];
    float p[3] = {x * c + y * sn, -x * sn + y * c, z};
    float wobble = 0.12f * noise3(p[0] * 2.4f, p[1] * 2.4f, p[2] * 5);
    float band = 0.5f + 0.5f * sinf((p[2] + wobble) * 9.5f);
    float spot = SEGMENT.check1 ? 1 - smooth(0.28f, 0.5f, angleTo(p, spotAt)) : 0;
    float o[3];
    for (int k = 0; k < 3; k++) o[k] = (dark[k] + (light[k] - dark[k]) * band) * (1 - spot) + red[k] * spot;
    s->f.put(i, o[0], o[1], o[2]);
  }
  show(s->f);
}
static const char _data_jupiter[] PROGMEM = "Glorby Jupiter@!,,,,,Red spot;;;;sx=64,o1=1";

// Basketball: orange with black seams, spinning.
static void mode_basketball() {
  bool fresh;
  auto *s = begin<SpinState>(fresh);
  if (!s) return fallback();
  s->turn += s->dt * slider(SEGMENT.speed, -6.f, 6.f) * 0.8f;
  const float t = slider(SEGMENT.intensity, -90.f, 90.f) * (PI / 180.f);
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], py = GEO_POS[i][1], pz = GEO_POS[i][2];
    float y = py * cosf(t) - pz * sinf(t);
    float z = py * sinf(t) + pz * cosf(t);
    float a = x * cosf(s->turn) - z * sinf(s->turn);
    float c = x * sinf(s->turn) + z * cosf(s->turn);
    float seam = fminf(fabsf(y), fminf(fabsf(a), fabsf(fabsf(c) - 0.62f - 0.3f * y * y)));
    float k = 0.08f + 0.92f * smooth(0.02f, 0.11f, seam);
    s->f.put(i, 0.95f * k, 0.32f * k, 0.03f * k);
  }
  show(s->f);
}
static const char _data_basketball[] PROGMEM = "Glorby Basketball@Spin,Tilt;;;;sx=149,ix=156";

// Pumpkin: a carved face lit by a flickering candle.
static void mode_pumpkin() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  static View v;
  static uint8_t cut[N];
  static const float pts[][2] = {{-0.42f, 0.4f}, {-0.3f, 0.2f}, {0.42f, 0.4f}, {0.3f, 0.2f}, {0, 0.05f},
                                 {-0.7f, -0.2f}, {-0.45f, -0.45f}, {-0.15f, -0.6f}, {0.15f, -0.6f}, {0.45f, -0.45f}, {0.7f, -0.2f}};
  makeView(v, facingOf());
  nearestMarks(v, pts, 11, cut);
  const float flicker = SEGMENT.intensity / 255.f;
  const float flame = 1 - flicker * 0.55f * (0.5f + 0.5f * sinf(s->t * 13) * sinf(s->t * 7.3f));
  for (int i = 0; i < N; i++) {
    if (cut[i]) s->f.put(i, flame, 0.82f * flame, 0.2f * flame);
    else {
      float ribs = (0.62f + 0.38f * fabsf(cosf(LON[i] * 5))) * 0.5f;
      s->f.put(i, 0.8f * ribs, 0.24f * ribs, 0.01f * ribs);
    }
  }
  show(s->f);
}
static const char _data_pumpkin[] PROGMEM = "Glorby Pumpkin@,Candle flicker,,Facing;;;;ix=179,c2=128";

// ---- Faces --------------------------------------------------------------------

// Eye: looks around and blinks.
struct EyeState : Base { float gaze[2], target[2], nextLook, nextBlink, blinkAt; Frame f; };
static void mode_eye() {
  bool fresh;
  auto *s = begin<EyeState>(fresh);
  if (!s) return fallback();
  if (fresh) { s->nextBlink = 2; s->blinkAt = -9; }
  static View v;
  makeView(v, facingOf());
  if (SEGMENT.check1) {
    if (s->t > s->nextLook) {
      s->target[0] = uniform(-0.8f, 0.8f);
      s->target[1] = uniform(-0.8f, 0.8f) * 0.6f;
      s->nextLook = s->t + uniform(0.8f, 3.2f);
    }
  } else {
    s->target[0] = slider(SEGMENT.custom1, -1.f, 1.f);
    s->target[1] = (SEGMENT.custom3 - 16) / 15.f;
  }
  const float follow = fminf(1.f, s->dt * 12);
  for (int k = 0; k < 2; k++) s->gaze[k] += (s->target[k] - s->gaze[k]) * follow;
  if (SEGMENT.check2 && s->t > s->nextBlink) { s->blinkAt = s->t; s->nextBlink = s->t + uniform(2, 6); }
  const float closed = fmaxf(0.f, 1 - fabsf(s->t - s->blinkAt - 0.11f) / 0.11f);
  float gaze[3] = {1, s->gaze[0] * 0.9f, s->gaze[1] * 0.9f};
  unit3(gaze);
  const float pupil = slider(SEGMENT.intensity, 0.1f, 0.6f);
  const RGBf irisC = fromColor(SEGCOLOR(0)), sclera = fromColor(SEGCOLOR(1));
  static const float skin[3] = {0.22f, 0.06f, 0.04f};
  for (int i = 0; i < N; i++) {
    float q[3] = {v.forward[i], v.right[i], v.up[i]};
    float a = angleTo(q, gaze);
    float shade = 0.35f + 0.65f * smooth(-0.4f, 0.5f, v.forward[i]);
    float iris = 1 - smooth(pupil + 0.42f, pupil + 0.62f, a);
    float ring = 0.65f + 0.35f * cosf(a * 9);
    float dark = 1 - smooth(pupil * 0.9f, pupil + 0.18f, a);
    float lid = smooth(0, 0.25f, 1 - closed * 1.05f - fabsf(v.up[i]) * 0.9f);
    const float sc[3] = {sclera.r, sclera.g, sclera.b}, ic[3] = {irisC.r, irisC.g, irisC.b};
    float o[3];
    for (int c = 0; c < 3; c++) {
      float val = sc[c] * shade;
      val = val * (1 - iris) + ic[c] * ring * iris;
      val *= 1 - dark;
      o[c] = val * lid + skin[c] * (1 - lid);
    }
    s->f.put(i, o[0], o[1], o[2]);
  }
  show(s->f);
}
static const char _data_eye[] PROGMEM =
    "Glorby Eye@,Pupil,Look left/right,Facing,Look up/down,Look around,Blinks;Iris,White;;;ix=102,c1=128,c2=128,c3=16,o1=1,o2=1";

// Face: a simple face with moods.
static const char *const MOODS[] = {"Happy", "Sad", "Surprised", "Wink", "Angry", "Sleepy"};
static void mode_face() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const int mood = min(5, SEGMENT.custom1 / 43);
  const float bob = SEGMENT.intensity / 255.f;
  static View v;
  makeView(v, facingOf(), sinf(s->t * 0.9f) * 0.1f * bob, sinf(s->t * 1.6f) * 0.04f * bob);
  const bool blink = modf_(s->t, 4.1f) < 0.14f;
  float pts[16][2];
  int n = 0;
  for (int side = -1; side <= 1; side += 2) {
    bool closed = blink || mood == 5 || (mood == 3 && side == 1);
    if (!closed) { pts[n][0] = side * 0.4f; pts[n++][1] = 0.35f; }
    if (mood == 2) { pts[n][0] = side * 0.4f; pts[n++][1] = 0.55f; }
    if (mood == 4) { pts[n][0] = side * 0.22f; pts[n++][1] = 0.42f; }
  }
  static const float smile[][2] = {{-0.65f, -0.15f}, {-0.4f, -0.45f}, {-0.13f, -0.6f}, {0.13f, -0.6f}, {0.4f, -0.45f}, {0.65f, -0.15f}};
  static const float sad[][2] = {{-0.5f, -0.65f}, {-0.25f, -0.4f}, {0.25f, -0.4f}, {0.5f, -0.65f}};
  static const float angry[][2] = {{-0.4f, -0.5f}, {0, -0.5f}, {0.4f, -0.5f}};
  static const float sleepy[][2] = {{0, -0.5f}};
  static const float surprised[][2] = {{0, -0.45f}, {0, -0.7f}};
  const float (*mouth)[2] = smile;
  int mn = 6;
  if (mood == 1) { mouth = sad; mn = 4; }
  else if (mood == 2) { mouth = surprised; mn = 2; }
  else if (mood == 4) { mouth = angry; mn = 3; }
  else if (mood == 5) { mouth = sleepy; mn = 1; }
  for (int k = 0; k < mn; k++) { pts[n][0] = mouth[k][0]; pts[n++][1] = mouth[k][1]; }
  static uint8_t marks[N];
  nearestMarks(v, pts, n, marks);
  const RGBf skinC = fromColor(SEGCOLOR(0)), feature = fromColor(SEGCOLOR(1));
  for (int i = 0; i < N; i++) {
    float k = 0.55f + 0.45f * smooth(-1, 0.2f, v.forward[i]);
    if (marks[i]) s->f.put(i, feature);
    else s->f.put(i, skinC, k);
  }
  show(s->f);
}
static const char _data_face[] PROGMEM = "Glorby Face@,Bob,Mood,Facing;Skin,Features;;;ix=77,c1=0,c2=128";

// ---- Ambient ----------------------------------------------------------------

// Aurora: curtains of light round the upper sphere.
static void mode_aurora() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float height = slider(SEGMENT.intensity, -1.f, 1.f);
  for (int i = 0; i < N; i++) {
    const float *p = GEO_POS[i];
    float curtain = fbm(p[0] * 1.4f, p[1] * 1.4f, s->clock * 0.25f, 3);
    float x = (p[2] - height - curtain * 0.35f) / 0.42f;
    float band = expf(-x * x);
    float shimmer = 0.6f + 0.4f * sinf(LON[i] * 7 + s->clock * 2 + curtain * 7);
    s->f.put(i, pal(0.25f + band * 0.55f + curtain * 0.2f, false), band * shimmer);
  }
  show(s->f);
}
static const char _data_aurora[] PROGMEM = "Glorby Aurora@!,Height;;!;;sx=64,ix=166";

// Nebula: warped clouds of colour.
static void mode_nebula() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float sc = slider(SEGMENT.intensity, 0.4f, 4.f);
  const float c = s->clock;
  for (int i = 0; i < N; i++) {
    const float *p = GEO_POS[i];
    float warp = fbm(p[0] * sc + c * 0.1f, p[1] * sc + c * 0.1f, p[2] * sc + c * 0.1f, 2) * 1.2f;
    float field = fbm(p[0] * sc + warp, p[1] * sc + warp + c * 0.08f, p[2] * sc + warp, 3);
    s->f.put(i, pal(0.5f + field * 0.9f, true), smooth(-0.45f, 0.25f, field));
  }
  show(s->f);
}
static const char _data_nebula[] PROGMEM = "Glorby Nebula@!,Scale;;!;;sx=38,ix=78";

// Plasma: overlapping sine fields.
static void mode_plasma() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float sc = slider(SEGMENT.intensity, 0.5f, 8.f);
  const float t = s->clock;
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], y = GEO_POS[i][1], z = GEO_POS[i][2];
    float v = sinf(x * sc + t) + sinf(y * sc * 0.8f - t * 1.3f) + sinf(z * sc * 1.2f + t * 0.7f) +
              sinf((x + y + z) * sc * 0.7f + t * 1.7f);
    s->f.put(i, pal(v * 0.125f + 0.5f + t * 0.03f, true));
  }
  show(s->f);
}
static const char _data_plasma[] PROGMEM = "Glorby Plasma@!,Scale;;!;;sx=64,ix=68";

// Lava Lamp: metaballs drifting inside the sphere.
struct LavaState : Base { float seed[9][3]; Frame f; };
static void mode_lava() {
  bool fresh;
  auto *s = begin<LavaState>(fresh);
  if (!s) return fallback();
  if (fresh) for (int b = 0; b < 9; b++) for (int j = 0; j < 3; j++) s->seed[b][j] = frand() * 100;
  const int blobs = (int)slider(SEGMENT.intensity, 2, 9.99f);
  const float c = s->clock;
  float total[N] = {0};
  for (int b = 0; b < blobs; b++) {
    const float *sd = s->seed[b];
    float center[3] = {0.75f * sinf(c * 0.21f + sd[0]), 0.75f * sinf(c * 0.17f + sd[1]), 0.75f * sinf(c * (0.13f + b * 0.015f) + sd[2])};
    for (int i = 0; i < N; i++) {
      float dx = GEO_POS[i][0] - center[0], dy = GEO_POS[i][1] - center[1], dz = GEO_POS[i][2] - center[2];
      total[i] += 0.22f / (dx * dx + dy * dy + dz * dz + 0.05f);
    }
  }
  float mean = 0;
  for (int i = 0; i < N; i++) mean += total[i];
  mean /= N;
  for (int i = 0; i < N; i++) s->f.put(i, pal(0.5f + (total[i] - mean) * 1.1f, false));
  show(s->f);
}
static const char _data_lava[] PROGMEM = "Glorby Lava Lamp@!,Blobs;;!;;sx=64,ix=109";

// Deep Ocean: caustics rippling over a deepening blue.
static void mode_ocean() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float c = s->clock;
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], y = GEO_POS[i][1], z = GEO_POS[i][2];
    float a = fbm(x * 2.2f + c * 0.2f, y * 2.2f, z * 2.2f + c * 0.12f, 2);
    float b = fbm(x * 2.9f, y * 2.9f - c * 0.16f, z * 2.9f - c * 0.1f, 2);
    float caustic = clampf(1 - fabsf(a - b) * 3.2f, 0, 1);
    float depth = 0.25f + 0.4f * smooth(-1, 1, z);
    s->f.put(i, pal(depth + caustic * caustic * caustic * 0.55f, false));
  }
  show(s->f);
}
static const char _data_ocean[] PROGMEM = "Glorby Deep Ocean@!;;!;;sx=64";

// Fireball: flames licking up the sphere.
static void mode_fireball() {
  bool fresh;
  auto *s = begin<PlainState>(fresh);
  if (!s) return fallback();
  const float height = slider(SEGMENT.intensity, 0.1f, 1.f);
  for (int i = 0; i < N; i++) {
    const float x = GEO_POS[i][0], y = GEO_POS[i][1], z = GEO_POS[i][2];
    float n = fbm(x * 2.5f, y * 2.5f, z * 1.3f - s->clock * 1.1f, 3);
    float h = (z + 1) / 2;
    s->f.put(i, pal(1.05f - h * (1.25f - height) + n * 0.45f, false));
  }
  show(s->f);
}
static const char _data_fireball[] PROGMEM = "Glorby Fireball@!,Flame height;;!;;sx=77,ix=156";

// Starfield: twinkling stars on a night sky.
struct StarState : Base { float v[N]; Frame f; };
static void mode_stars() {
  bool fresh;
  auto *s = begin<StarState>(fresh);
  if (!s) return fallback();
  if (fresh) for (int i = 0; i < N; i++) s->v[i] = frand();
  const float density = slider(SEGMENT.intensity, 0.02f, 1.f);
  const float chance = density * s->dt * speedOf() * 2.5f;
  const float decay = expf(-s->dt * speedOf() * 1.3f);
  const RGBf tint = fromColor(SEGCOLOR(0)), sky = fromColor(SEGCOLOR(1));
  for (int i = 0; i < N; i++) {
    s->v[i] = frand() < chance ? 1.f : s->v[i] * decay;
    float k = s->v[i] * s->v[i];
    s->f.put(i, sky.r + tint.r * k, sky.g + tint.g * k, sky.b + tint.b * k);
  }
  show(s->f);
}
static const char _data_stars[] PROGMEM = "Glorby Starfield@!,Density;Tint,Night sky;;;sx=64,ix=60";

// Matrix: streams of code falling down meridians, pole to pole.
static constexpr int MAX_STREAMS = 14;
struct MatrixState : Base { float lon[MAX_STREAMS], head[MAX_STREAMS], rate[MAX_STREAMS], glyph[N]; Frame f; };
static void mode_matrix() {
  bool fresh;
  auto *s = begin<MatrixState>(fresh);
  if (!s) return fallback();
  if (fresh) {
    for (int k = 0; k < MAX_STREAMS; k++) { s->lon[k] = uniform(-PI, PI); s->head[k] = uniform(0, PI + 1.5f); s->rate[k] = uniform(0.7f, 1.4f); }
    for (int i = 0; i < N; i++) s->glyph[i] = uniform(0.35f, 1);
  }
  static constexpr float FALL = 0.9f, HEAD = 0.4f;
  const float dt = s->dt * speedOf();
  const int streams = (int)slider(SEGMENT.custom1, 2, MAX_STREAMS + 0.99f);
  const float trail = slider(SEGMENT.intensity, 0.4f, 3.f);
  for (int k = 0; k < MAX_STREAMS; k++) {
    s->head[k] += s->rate[k] * FALL * dt;
    if (s->head[k] > PI + trail) { s->lon[k] = uniform(-PI, PI); s->head[k] = uniform(-1.2f, 0); s->rate[k] = uniform(0.7f, 1.4f); }
  }
  for (int i = 0; i < N; i++) if (frand() < 6 * dt) s->glyph[i] = uniform(0.35f, 1);
  const RGBf body = fromColor(SEGCOLOR(0)), leadC = fromColor(SEGCOLOR(1));
  for (int i = 0; i < N; i++) {
    const float down = PI / 2 - LAT[i];
    float lit = 0, lead = 0;
    for (int k = 0; k < streams; k++) {
      float across = fabsf(modf_(LON[i] - s->lon[k] + PI, TWO_PI) - PI) * cosf(LAT[i]);
      float column = 1 - smooth(0.2f, 0.4f, across);
      float behind = s->head[k] - down;
      bool ahead = behind < 0;
      lit = fmaxf(lit, column * (ahead ? 0 : expf(-fmaxf(behind, 0) / (trail * 0.45f))));
      lead = fmaxf(lead, column * (ahead || behind > HEAD ? 0 : 1));
    }
    float k = lit * s->glyph[i];
    s->f.put(i, body.r * k * (1 - lead) + leadC.r * lead, body.g * k * (1 - lead) + leadC.g * lead, body.b * k * (1 - lead) + leadC.b * lead);
  }
  show(s->f);
}
static const char _data_matrix[] PROGMEM = "Glorby Matrix@!,Trail,Streams;Color,Lead color;;;sx=64,ix=108,c1=100";

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
  void loop() override {}

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
    strip.addEffect(255, &mode_aurora, _data_aurora);
    strip.addEffect(255, &mode_nebula, _data_nebula);
    strip.addEffect(255, &mode_plasma, _data_plasma);
    strip.addEffect(255, &mode_lava, _data_lava);
    strip.addEffect(255, &mode_ocean, _data_ocean);
    strip.addEffect(255, &mode_fireball, _data_fireball);
    strip.addEffect(255, &mode_stars, _data_stars);
    strip.addEffect(255, &mode_matrix, _data_matrix);
    for (int k = 0; k < LANDS; k++) dirLatLon(LAND[k].lat, LAND[k].lon, LAND_AT[k]);
    EMBER = buildPalette(PALETTES[1]);
    strip.addEffect(255, &mode_earth, _data_earth);
    strip.addEffect(255, &mode_moon, _data_moon);
    strip.addEffect(255, &mode_sun, _data_sun);
    strip.addEffect(255, &mode_jupiter, _data_jupiter);
    strip.addEffect(255, &mode_basketball, _data_basketball);
    strip.addEffect(255, &mode_pumpkin, _data_pumpkin);
    strip.addEffect(255, &mode_eye, _data_eye);
    strip.addEffect(255, &mode_face, _data_face);

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
    g[F("effects")] = 28;
    g[F("palettes")] = sizeof(glorby::PALETTES) / sizeof(glorby::PALETTES[0]);
  }

  uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }
};

static GlorbyFx glorby_fx;
REGISTER_USERMOD(glorby_fx);
