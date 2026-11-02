"""Constants for the Glorb integration."""
DOMAIN = "glorb"
VERSION = "0.3.2"

CONF_FPS = "fps"
DEFAULT_FPS = 30
# A hard limit: 40 fps hung the lamp until it was power-cycled, 30 held through soak tests.
MAX_FPS = 30
MIN_FPS = 5

# Orientation is on the device page so it applies live. The rest is under Configure.
CONF_FLIP = "flip"
CONF_MIRROR = "mirror"
CONF_ROTATION = "rotation"
CONF_GAMMA = "gamma"
CONF_TRANSITION = "transition"
CONF_ON_EFFECT = "on_effect"
CONF_RESUME = "resume"
CONF_MICROPHONE = "microphone"
ON_EFFECT_LAST = "last"
ON_EFFECT_LAMP = "lamp"
DEFAULTS = {
    CONF_FPS: DEFAULT_FPS,
    CONF_FLIP: True,  # A standing lamp has the first LEDs at its base.
    CONF_MIRROR: False,
    CONF_ROTATION: 0.0,
    CONF_GAMMA: 2.8,
    CONF_TRANSITION: 1.0,
    CONF_ON_EFFECT: ON_EFFECT_LAST,
    CONF_RESUME: True,
    CONF_MICROPHONE: True,
}

DDP_PORT = 4048
VIEW_EVERY_SECONDS = 1 / 20

# How often to check the lamp is alive while streaming, and how many misses stop it.
HEALTH_INTERVAL = 10
HEALTH_TIMEOUT = 4
HEALTH_MISSES = 2

STORAGE_VERSION = 1

STATIC_URL = "/glorb_static"
PANEL_PATH = "glorb"
