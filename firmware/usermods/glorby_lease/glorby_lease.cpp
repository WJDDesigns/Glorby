// Gives the lamp back when a Glorby page stops driving it.
// A Glorby page claims the lamp by naming the main segment "Glorby <token>", setting
// lor 2 and streaming frames as {"seg":{"i":[...]}}. If the page goes away without
// handing back (Mac asleep, tab frozen, network gone), the lamp would sit dark.
// This lease ends the claim once no JSON has arrived for leaseS seconds.
#include "wled.h"

class GlorbyLease : public Usermod {
  bool enabled = true;
  uint16_t leaseS = 30;
  unsigned long lastJson = 0;
  unsigned long lastCheck = 0;
  uint32_t released = 0;

  static bool claimed(const Segment &seg) {
    return seg.name && strncmp(seg.name, "Glorby ", 7) == 0;
  }

  void release() {
    Segment &seg = strip.getMainSegment();
    realtimeOverride = REALTIME_OVERRIDE_NONE;
    for (unsigned i = 0; i < strip.getSegmentsNum(); i++) strip.getSegment(i).freeze = false;
    seg.clearName();
    released++;
    if (!(bootPreset && applyPreset(bootPreset))) {
      seg.setMode(FX_MODE_COLORWAVES);
      stateChanged = true;
      stateUpdated(CALL_MODE_DIRECT_CHANGE);
    }
  }

 public:
  void setup() override {}

  void readFromJsonState(JsonObject &root) override { lastJson = millis(); }

  void loop() override {
    if (!enabled) return;
    const unsigned long now = millis();
    if (now - lastCheck < 1000) return;
    lastCheck = now;
    if (claimed(strip.getMainSegment()) && now - lastJson > leaseS * 1000UL) release();
  }

  void addToJsonInfo(JsonObject &root) override {
    JsonObject lease = root.createNestedObject(F("lease"));
    lease[F("released")] = released;
    lease[F("claimed")] = claimed(strip.getMainSegment());
  }

  void addToConfig(JsonObject &root) override {
    JsonObject top = root.createNestedObject(F("GlorbyLease"));
    top[F("enabled")] = enabled;
    top[F("leaseS")] = leaseS;
  }

  bool readFromConfig(JsonObject &root) override {
    JsonObject top = root[F("GlorbyLease")];
    if (top.isNull()) return false;
    getJsonValue(top[F("enabled")], enabled);
    getJsonValue(top[F("leaseS")], leaseS);
    leaseS = constrain(leaseS, 5, 600);
    return true;
  }

  uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }
};

static GlorbyLease glorby_lease;
REGISTER_USERMOD(glorby_lease);
