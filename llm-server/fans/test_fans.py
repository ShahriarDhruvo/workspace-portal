"""python3 -m unittest llm-server/fans/test_fans.py"""
import importlib.util
import signal
import tempfile
import unittest
from unittest import mock
from pathlib import Path

_spec = importlib.util.spec_from_file_location('m5_fans', Path(__file__).with_name('m5-fans.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)


class Curve(unittest.TestCase):
    def test_rising(self):
        expected = {59: 0, 60: 40, 62: 40, 63: 40, 64: 45, 70: 55, 75: 60, 80: 70, 84: 75, 85: 80, 89: 80, 90: 95, 110: 95}
        self.assertEqual({temp: F.target_duty(temp, 0) for temp in expected}, expected)

    def test_falling_holds_until_the_lower_threshold(self):
        self.assertEqual([F.target_duty(temp, 95) for temp in (89, 87, 86)], [95, 95, 80])
        self.assertEqual([F.target_duty(temp, 40) for temp in (59, 55, 54)], [40, 40, 0])
        self.assertEqual(F.target_duty(89, 80), 80)

    def test_never_between_1_and_39_or_above_95(self):
        duties = {F.target_duty(temp, previous) for temp in range(0, 126) for previous in (0, 40, 80, 95)}
        self.assertTrue(all(duty == 0 or 40 <= duty <= 95 for duty in duties), duties)


class Sensors(unittest.TestCase):
    def hwmon(self, **sensors):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for index, (name, value) in enumerate(sensors.items()):
            (root / f'hwmon{index}').mkdir()
            (root / f'hwmon{index}' / 'name').write_text(name + '\n')
            (root / f'hwmon{index}' / 'temp1_input').write_text(f'{value}\n')
        return root

    def test_the_hotter_of_cpu_and_gpu(self):
        self.assertEqual(F.temperature(self.hwmon(k10temp=71500, amdgpu=83999, nvme=99000)), 83)

    def test_a_missing_or_implausible_sensor_is_an_error(self):
        for sensors in ({'k10temp': 70000}, {'k10temp': 70000, 'amdgpu': 200000}, {'k10temp': 70000, 'amdgpu': -1}, {'k10temp': 'x', 'amdgpu': 60000}):
            with self.assertRaises(RuntimeError):
                F.temperature(self.hwmon(**sensors))


class Duty(unittest.TestCase):
    real = staticmethod(F.write_duty)

    def ec(self, error):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for fan in F.FANS:
            (root / fan).mkdir()
            (root / fan / 'duty_error').write_text(f'{error}\n')
        return root

    def test_writes_both_fans(self):
        ec = self.ec(0)
        F.write_duty(80, ec)
        self.assertEqual([(ec / fan / 'duty').read_text() for fan in F.FANS], ['80\n', '80\n'])

    def test_an_ec_error_stops_the_daemon(self):
        ec = self.ec(-5)
        with self.assertRaises(RuntimeError):
            F.write_duty(80, ec)
        self.assertFalse((ec / 'fan1' / 'duty').exists())

    def test_without_readings_95_and_sigterm_releases_both_fans(self):
        ec, held = self.ec(0), []
        self.addCleanup(signal.signal, signal.SIGTERM, signal.getsignal(signal.SIGTERM))

        def sleep(seconds):
            self.assertLess(seconds, 5)   # the module's hold is 10 seconds
            held.extend((ec / fan / 'duty').read_text() for fan in F.FANS)
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)

        with mock.patch.multiple(F, EC=ec, temperature=mock.Mock(side_effect=RuntimeError), write_duty=lambda duty: Duty.real(duty, ec)), \
             mock.patch.object(F.time, 'sleep', sleep), mock.patch.object(F.sys, 'stderr'), self.assertRaises(SystemExit) as stopped:
            F.main()
        self.assertEqual((stopped.exception.code, held), (0, ['95\n', '95\n']))
        self.assertEqual([(ec / fan / 'duty').read_text() for fan in F.FANS], ['0\n', '0\n'])


if __name__ == '__main__':
    unittest.main()
