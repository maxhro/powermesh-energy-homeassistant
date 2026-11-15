"""Fixtures for Home Assistant based tests."""

from __future__ import annotations

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"
import sys
import socket
import pytest_socket

if sys.platform == "win32":
    import aiohttp.connector
    import aiohttp.resolver
    import homeassistant.helpers.aiohttp_client

    homeassistant.helpers.aiohttp_client.AsyncResolver = aiohttp.resolver.ThreadedResolver
    aiohttp.connector.DefaultResolver = aiohttp.resolver.ThreadedResolver
    aiohttp.resolver.DefaultResolver = aiohttp.resolver.ThreadedResolver
    aiohttp.resolver.AsyncResolver = aiohttp.resolver.ThreadedResolver

    _orig_disable = pytest_socket.disable_socket

    def _patched_disable(allow_unix_socket=False):
        _orig_disable(allow_unix_socket=allow_unix_socket)
        _guard = socket.socket

        class WindowsGuardedSocket(_guard):
            def __new__(cls, family=-1, type=-1, proto=-1, fileno=None):
                if fileno is not None or (family == socket.AF_INET and type == socket.SOCK_STREAM and proto == 0):
                    return pytest_socket._true_socket(family, type, proto, fileno=fileno)
                return super().__new__(cls, family, type, proto, fileno)

        socket.socket = WindowsGuardedSocket

    pytest_socket.disable_socket = _patched_disable





ENERGY = {"unit_of_measurement": "kWh", "device_class": "energy", "state_class": "total_increasing"}
POWER = {"unit_of_measurement": "W", "device_class": "power", "state_class": "measurement"}
GAS = {"unit_of_measurement": "m³", "device_class": "gas", "state_class": "total_increasing"}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Allow loading custom_components/powermesh_energy."""
    yield


@pytest.fixture
def cloud_transfer(monkeypatch):
    """Re-enable the disabled powermesh.de transfer for its retained tests."""
    monkeypatch.setattr("custom_components.powermesh_energy.const.CLOUD_TRANSFER_ENABLED", True)
    yield
