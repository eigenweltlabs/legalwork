"""Measure one child command without mixing resource peaks from other cases."""
import json
import pathlib
import subprocess
import sys
import time
try:
    import resource
except ImportError:
    resource = None

request = json.loads(pathlib.Path(sys.argv[1]).read_text())
started = time.perf_counter()
with open(request['log'], 'w') as log:
    result = subprocess.run(request['command'], cwd=request['cwd'], env=request['env'], stdout=log, stderr=subprocess.STDOUT)
usage = resource.getrusage(resource.RUSAGE_CHILDREN) if resource else None
measurement = {'wallSeconds': time.perf_counter() - started, 'exitCode': result.returncode,
               'cpuSeconds': usage.ru_utime + usage.ru_stime if usage else None,
               'peakRssMiB': usage.ru_maxrss / (1024 * 1024 if sys.platform == 'darwin' else 1024) if usage else None}
pathlib.Path(request['result']).write_text(json.dumps(measurement))
sys.exit(result.returncode)
