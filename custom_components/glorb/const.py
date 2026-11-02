"""Constants for the Glorb integration."""
DOMAIN = "glorb"
VERSION = "0.1.0"

CONF_FPS = "fps"
DEFAULT_FPS = 30
# A hard limit: 40 fps hung the lamp until it was power-cycled, 30 held through soak tests.
MAX_FPS = 30
MIN_FPS = 5

DDP_PORT = 4048
VIEW_EVERY_SECONDS = 1 / 20

# How often to check the lamp is alive while streaming, and how many misses stop it.
HEALTH_INTERVAL = 10
HEALTH_TIMEOUT = 4
HEALTH_MISSES = 2

STORAGE_VERSION = 1

STATIC_URL = "/glorb_static"
PANEL_PATH = "glorb"
