"""Boot regressions, run while building each guest architecture."""
import errno
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import call, patch

spec = importlib.util.spec_from_file_location("relay", Path(__file__).with_name("relay.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class HostChannelTests(unittest.TestCase):
    def test_device_node_can_appear_before_the_host_connects(self):
        delayed = [OSError(errno.ENOENT, "missing"), OSError(errno.ENXIO, "not connected"), 3]
        with patch.object(relay.os, "open", side_effect=delayed) as opened, \
                patch.object(relay.os, "dup2") as duplicate, \
                patch.object(relay.os, "close") as close, \
                patch.object(relay.time, "sleep") as sleep:
            relay.connect_host_channel()
            self.assertEqual(opened.call_count, 3)
            self.assertEqual(duplicate.call_args_list, [call(3, 0), call(3, 1)])
            close.assert_called_once_with(3)
            self.assertEqual(sleep.call_count, 2)

    def test_missing_channel_expires_without_running_a_command(self):
        with patch.object(relay.os, "open", side_effect=OSError(errno.ENXIO, "not connected")), \
                patch.object(relay.os, "dup2") as duplicate, \
                patch.object(relay.time, "monotonic", side_effect=[0, 61]):
            with self.assertRaises(OSError):
                relay.connect_host_channel()
            duplicate.assert_not_called()

    def test_unexpected_open_errors_fail_immediately(self):
        with patch.object(relay.os, "open", side_effect=OSError(errno.EACCES, "denied")), \
                patch.object(relay.time, "sleep") as sleep:
            with self.assertRaises(PermissionError):
                relay.connect_host_channel()
            sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
