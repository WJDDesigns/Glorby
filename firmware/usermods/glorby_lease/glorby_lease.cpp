// Gives the lamp back when a Glorby page stops driving it.
// A Glorby page claims the lamp by naming the main segment "Glorby <token>", setting
// lor 2 and streaming frames as {"seg":{"i":[...]}}. If the page goes away without
// handing back (Mac asleep, tab frozen, network gone), the lamp would sit dark.
// This lease ends the claim once no JSON has arrived for leaseS seconds.
//
// It also undoes WLED's low-memory fallback. When the largest free memory block stays
// under MIN_HEAP_SIZE for 15 s, WLED switches every segment to Solid (and after 30 s
// resets the segments). On this lamp that happens during its Wi-Fi stalls, when network
// buffers pile up, and the lamp then stays on Solid for good. We keep a copy of the main
// segment's effect and settings while memory is healthy, and once memory has recovered
// we put that effect back.
#include "wled.h"

class GlorbyLease : public Usermod {
  bool enabled = true;
  uint16_t leaseS = 60;  // longer than a Wi-Fi dropout, so a live page keeps its claim
  unsigned long lastJson = 0;
  unsigned long lastCheck = 0;
  uint32_t released = 0;

  // relight after WLED's low-memory fallback
  bool relight = true;
  struct Snap {
    bool valid = false;
    uint8_t mode, palette, speed, intensity, c1, c2, c3;
    bool o1, o2, o3;
    uint32_t col[NUM_COLORS];
    char name[WLED_MAX_SEGNAME_LEN + 1];
  } snap;
  unsigned long lastLowHeap = 0;   // last time the largest block was under WLED's limit
  bool lowSeen = false;
  unsigned long healthySince = 0;
  uint32_t minBlock = UINT32_MAX;  // smallest largest-free-block seen since boot
  uint32_t relit = 0;

  static bool claimed(const Segment &seg) {
    return seg.name && strncmp(seg.name, "Glorby ", 7) == 0;
  }

  // Goes through WLED's own JSON path under the JSON buffer lock, like any other client,
  // so the web server task never sees a half-changed segment (e.g. a freed name).
  bool release() {
    if (!requestJSONBufferLock(JSON_LOCK_REMOTE)) return false;
    pDoc->clear();
    JsonObject root = pDoc->to<JsonObject>();
    root[F("lor")] = 0;
    JsonArray segs = root.createNestedArray(F("seg"));
    for (unsigned i = 0; i < strip.getSegmentsNum(); i++) {
      JsonObject s = segs.createNestedObject();
      s[F("id")] = i;
      s[F("frz")] = false;
      if (i == strip.getMainSegmentId()) s[F("n")] = "";
    }
    if (bootPreset) root[F("ps")] = bootPreset;
    else segs[strip.getMainSegmentId()][F("fx")] = FX_MODE_COLORWAVES;
    deserializeState(root, CALL_MODE_DIRECT_CHANGE);
    releaseJSONBufferLock();
    released++;
    return true;
  }

 public:
  void setup() override {}

  void readFromJsonState(JsonObject &root) override { lastJson = millis(); }

  void takeSnap(const Segment &seg) {
    snap.mode = seg.mode; snap.palette = seg.palette;
    snap.speed = seg.speed; snap.intensity = seg.intensity;
    snap.c1 = seg.custom1; snap.c2 = seg.custom2; snap.c3 = seg.custom3;
    snap.o1 = seg.check1; snap.o2 = seg.check2; snap.o3 = seg.check3;
    for (unsigned i = 0; i < NUM_COLORS; i++) snap.col[i] = seg.colors[i];
    strlcpy(snap.name, seg.name ? seg.name : "", sizeof(snap.name));
    snap.valid = true;
  }

  bool restoreSnap() {
    if (!requestJSONBufferLock(JSON_LOCK_REMOTE)) return false;
    pDoc->clear();
    JsonObject root = pDoc->to<JsonObject>();
    JsonArray segs = root.createNestedArray(F("seg"));
    JsonObject s = segs.createNestedObject();
    s[F("id")] = strip.getMainSegmentId();
    s[F("on")] = true;
    s[F("frz")] = false;
    s[F("fx")] = snap.mode;
    s[F("pal")] = snap.palette;
    s[F("sx")] = snap.speed;
    s[F("ix")] = snap.intensity;
    s[F("c1")] = snap.c1;
    s[F("c2")] = snap.c2;
    s[F("c3")] = snap.c3;
    s[F("o1")] = snap.o1;
    s[F("o2")] = snap.o2;
    s[F("o3")] = snap.o3;
    s[F("n")] = snap.name;
    JsonArray cols = s.createNestedArray(F("col"));
    for (unsigned i = 0; i < NUM_COLORS; i++) {
      JsonArray c = cols.createNestedArray();
      c.add(R(snap.col[i])); c.add(G(snap.col[i])); c.add(B(snap.col[i])); c.add(W(snap.col[i]));
    }
    deserializeState(root, CALL_MODE_DIRECT_CHANGE);
    releaseJSONBufferLock();
    relit++;
    return true;
  }

  void checkRelight(unsigned long now) {
    const uint32_t block = getContiguousFreeHeap();
    if (block < minBlock) minBlock = block;
    // WLED counts a reading under MIN_HEAP_SIZE - 1024 as dangerous; leave a margin
    if (block < MIN_HEAP_SIZE + 2048) { lastLowHeap = now; lowSeen = true; healthySince = 0; }
    else if (!healthySince) healthySince = now;

    const Segment &seg = strip.getMainSegment();
    if (claimed(seg) || realtimeMode != REALTIME_MODE_INACTIVE) return;
    // only remember settings while memory is fine, so the fallback's Solid isn't saved
    if (!lowSeen) { takeSnap(seg); return; }
    if (!healthySince || now - healthySince < 10000UL) return;  // wait until memory has recovered

    // Memory dipped and has now been healthy for 10 s. If the effect fell to Solid and
    // nobody chose that after memory recovered, it was WLED's fallback: put it back.
    if (seg.mode == FX_MODE_STATIC && snap.valid && snap.mode != FX_MODE_STATIC && lastJson < healthySince)
      restoreSnap();
    lowSeen = false;
  }

  void loop() override {
    const unsigned long now = millis();
    if (now - lastCheck < 1000) return;
    lastCheck = now;
    if (relight) checkRelight(now);
    if (enabled && claimed(strip.getMainSegment()) && now - lastJson > leaseS * 1000UL) release();
  }

  void addToJsonInfo(JsonObject &root) override {
    JsonObject lease = root.createNestedObject(F("lease"));
    lease[F("released")] = released;
    lease[F("claimed")] = claimed(strip.getMainSegment());
    lease[F("relit")] = relit;
    lease[F("minBlock")] = minBlock == UINT32_MAX ? 0 : minBlock;
    lease[F("block")] = getContiguousFreeHeap();
  }

  void addToConfig(JsonObject &root) override {
    JsonObject top = root.createNestedObject(F("GlorbyLease"));
    top[F("enabled")] = enabled;
    top[F("leaseS")] = leaseS;
    top[F("relight")] = relight;
  }

  bool readFromConfig(JsonObject &root) override {
    JsonObject top = root[F("GlorbyLease")];
    if (top.isNull()) return false;
    getJsonValue(top[F("enabled")], enabled);
    getJsonValue(top[F("leaseS")], leaseS);
    getJsonValue(top[F("relight")], relight);
    leaseS = constrain(leaseS, 5, 600);
    return true;
  }

  uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }
};

static GlorbyLease glorby_lease;
REGISTER_USERMOD(glorby_lease);
