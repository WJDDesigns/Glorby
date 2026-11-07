// Network watchdog for ESP32: pings the gateway, and when replies stop while Wi-Fi still
// reports "connected", forces a Wi-Fi reconnect and, if that does not help, restarts.
// Written for the Glorb lamp, whose Wi-Fi stack can wedge silently while the rest keeps running.
#include "wled.h"
#ifdef ARDUINO_ARCH_ESP32
#include "ping/ping_sock.h"

class NetWatchdog : public Usermod {
  bool enabled = true;
  uint16_t intervalS = 15;     // seconds between pings
  uint8_t missLimit = 4;       // consecutive misses before acting (~1 min)
  uint16_t restartAfterS = 120; // restart if still unreachable this long after a forced reconnect

  esp_ping_handle_t ping = nullptr;
  volatile bool replied = false;
  volatile bool done = true;
  bool armed = false;          // only act once the gateway has answered since boot (some networks block ping)
  uint8_t misses = 0;
  unsigned long lastPing = 0;
  unsigned long reconnectAt = 0;
  uint32_t reconnects = 0, restarts = 0, pings = 0, lost = 0;

  static void onSuccess(esp_ping_handle_t, void *arg) { static_cast<NetWatchdog*>(arg)->replied = true; }
  static void onEnd(esp_ping_handle_t, void *arg) { static_cast<NetWatchdog*>(arg)->done = true; }

  void stopPing() {
    if (ping) { esp_ping_stop(ping); esp_ping_delete_session(ping); ping = nullptr; }
  }

  void startPing() {
    IPAddress gw = WiFi.gatewayIP();
    if (gw == IPAddress((uint32_t)0)) return;
    esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
    cfg.count = 1;
    cfg.timeout_ms = 2000;
    cfg.task_stack_size = 3072;
    ip_addr_t target = {};
    IP_ADDR4(&target, gw[0], gw[1], gw[2], gw[3]);
    cfg.target_addr = target;
    esp_ping_callbacks_t cbs = {};
    cbs.cb_args = this;
    cbs.on_ping_success = onSuccess;
    cbs.on_ping_end = onEnd;
    replied = false;
    done = false;
    if (esp_ping_new_session(&cfg, &cbs, &ping) != ESP_OK) { ping = nullptr; done = true; return; }
    esp_ping_start(ping);
    pings++;
  }

 public:
  void connected() override {
    misses = 0;  // stay armed: once the gateway has answered since boot, silence counts
  }

  void loop() override {
    if (!enabled) return;
    if (!WLED_CONNECTED) { if (ping && done) stopPing(); return; }
    const unsigned long now = millis();

    if (ping && done) {        // a ping round finished: score it
      stopPing();
      if (replied) {
        armed = true;
        misses = 0;
        reconnectAt = 0;
      } else if (armed) {
        misses++;
        lost++;
      }
    }

    if (armed && misses >= missLimit) {
      misses = 0;
      if (reconnectAt && now - reconnectAt > restartAfterS * 1000UL) {
        restarts++;
        DEBUG_PRINTLN(F("NetWatchdog: still unreachable after reconnect, restarting."));
        Serial.println(F("NetWatchdog: restart"));
        delay(50);
        ESP.restart();
      } else if (!reconnectAt) {
        reconnects++;
        reconnectAt = now;
        Serial.println(F("NetWatchdog: gateway silent, forcing Wi-Fi reconnect"));
        WiFi.disconnect();
        forceReconnect = true;
        return;
      }
    }

    if (!ping && now - lastPing >= intervalS * 1000UL) {
      lastPing = now;
      startPing();
    }
  }

  void addToJsonInfo(JsonObject &root) override {
    JsonObject user = root["u"];
    if (user.isNull()) user = root.createNestedObject("u");
    JsonArray a = user.createNestedArray(F("Net watchdog"));
    a.add(enabled ? (armed ? F("watching") : F("waiting for gateway")) : F("off"));
    JsonObject nw = root.createNestedObject(F("netwd"));
    nw[F("pings")] = pings;
    nw[F("lost")] = lost;
    nw[F("reconnects")] = reconnects;
    nw[F("armed")] = armed;
  }

  void addToConfig(JsonObject &root) override {
    JsonObject top = root.createNestedObject(F("NetWatchdog"));
    top[F("enabled")] = enabled;
    top[F("intervalS")] = intervalS;
    top[F("missLimit")] = missLimit;
    top[F("restartAfterS")] = restartAfterS;
  }

  bool readFromConfig(JsonObject &root) override {
    JsonObject top = root[F("NetWatchdog")];
    if (top.isNull()) return false;
    getJsonValue(top[F("enabled")], enabled);
    getJsonValue(top[F("intervalS")], intervalS);
    getJsonValue(top[F("missLimit")], missLimit);
    getJsonValue(top[F("restartAfterS")], restartAfterS);
    intervalS = constrain(intervalS, 5, 300);
    missLimit = constrain(missLimit, 2, 20);
    restartAfterS = constrain(restartAfterS, 30, 3600);
    return true;
  }

  uint16_t getId() override { return USERMOD_ID_UNSPECIFIED; }
};

static NetWatchdog net_watchdog;
REGISTER_USERMOD(net_watchdog);
#endif
