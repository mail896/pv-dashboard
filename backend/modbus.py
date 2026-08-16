"""Minimal Modbus TCP client with no write function implemented."""

from __future__ import annotations

import socket
import struct


class ModbusError(RuntimeError):
    pass


class ReadOnlyModbusClient:
    """Read holding registers through FC03 only."""

    def __init__(self, host: str, port: int, unit_id: int, timeout: float = 3.0):
        self.host = host
        self.port = port
        self.unit_id = unit_id
        self.timeout = timeout
        self.transaction_id = 0

    @staticmethod
    def _receive_exact(connection: socket.socket, size: int) -> bytes:
        chunks: list[bytes] = []
        remaining = size
        while remaining:
            chunk = connection.recv(remaining)
            if not chunk:
                raise ModbusError("connection closed before the response was complete")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def read_holding_registers(self, address: int, count: int) -> list[int]:
        if not 0 <= address <= 0xFFFF:
            raise ValueError("address outside Modbus range")
        if not 1 <= count <= 125:
            raise ValueError("count outside FC03 limit")

        self.transaction_id = (self.transaction_id + 1) & 0xFFFF
        request = struct.pack(
            ">HHHBBHH",
            self.transaction_id,
            0,
            6,
            self.unit_id,
            0x03,
            address,
            count,
        )

        with socket.create_connection((self.host, self.port), timeout=self.timeout) as connection:
            connection.settimeout(self.timeout)
            connection.sendall(request)
            header = self._receive_exact(connection, 7)
            transaction_id, protocol_id, length, unit_id = struct.unpack(">HHHB", header)
            payload = self._receive_exact(connection, length - 1)

        if transaction_id != self.transaction_id or protocol_id != 0:
            raise ModbusError("unexpected response header")
        if unit_id != self.unit_id:
            raise ModbusError("unexpected Modbus unit")
        if payload and payload[0] == 0x83:
            code = payload[1] if len(payload) > 1 else None
            raise ModbusError(f"FC03 exception {code}")
        if len(payload) < 2 or payload[0] != 0x03:
            raise ModbusError("unexpected function code")
        if payload[1] != count * 2 or len(payload[2:]) != count * 2:
            raise ModbusError("unexpected register payload size")
        return list(struct.unpack(f">{count}H", payload[2:]))

