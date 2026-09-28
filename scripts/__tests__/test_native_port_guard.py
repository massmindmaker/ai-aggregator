"""Verify the shell runner port guard without touching fixed database ports."""
from pathlib import Path
import socket
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'with-native-test-services.sh').read_text()
GUARD = SOURCE.split("python3 - <<'CHECK'\n", 1)[1].split('\nCHECK\n', 1)[0]

def probe(port):
    exec(GUARD.replace('(15432, 16379)', '(port,)'), {'port': port})

class NativePortGuard(unittest.TestCase):
    def test_existing_listener_is_never_reused(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', 0))
            server.listen()
            with self.assertRaises(OSError):
                probe(server.getsockname()[1])

    def test_closed_owned_connection_does_not_cause_false_busy(self):
        with socket.socket() as server, socket.socket() as client:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(('127.0.0.1', 0))
            port = server.getsockname()[1]
            server.listen()
            client.connect(('127.0.0.1', port))
            accepted, _ = server.accept()
            accepted.close()
            self.assertEqual(client.recv(1), b'')
        probe(port)

if __name__ == '__main__':
    unittest.main()
