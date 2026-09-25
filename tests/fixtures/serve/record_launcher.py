import json
import os
from pathlib import Path
import sys

Path(os.environ["ATLAS_LAUNCH_LOG"]).write_text(json.dumps(sys.argv[1:]), encoding="utf-8")
