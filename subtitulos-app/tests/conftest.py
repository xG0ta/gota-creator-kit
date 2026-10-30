import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(APP.parent), str(APP)]
