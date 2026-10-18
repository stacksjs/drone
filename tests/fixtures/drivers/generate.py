"""Optional development-only fixture generator: pymavlink==2.4.50, common v2 dialect."""
import json
import struct
from pathlib import Path
from pymavlink.dialects.v20 import common as m

fixtures = {}
def add(name, msg, system=245, component=191, signed=False):
    link = m.MAVLink(None, srcSystem=system, srcComponent=component)
    link.seq = 11
    if signed:
        link.signing.secret_key = bytes(range(32))
        link.signing.link_id = 7
        link.signing.timestamp = 1000000
        link.signing.sign_outgoing = True
    fixtures[name] = msg.pack(link).hex()

add('command', m.MAVLink_command_long_message(1, 1, 511, 0, 32, 200000, 0, 0, 0, 0, 0))
add('ack', m.MAVLink_command_ack_message(511, 0, 100, 0, 245, 191), 1, 1)
add('progress', m.MAVLink_command_ack_message(511, 5, 20, 0, 245, 191), 1, 1)
add('read', m.MAVLink_param_request_read_message(1, 1, b'TEST_INT', -1))
add('setCast', m.MAVLink_param_set_message(1, 1, b'TEST_INT', 42, 6))
add('setBytes', m.MAVLink_param_set_message(1, 1, b'TEST_INT', struct.unpack('<f', struct.pack('<i', 42))[0], 6))
add('valueCast', m.MAVLink_param_value_message(b'TEST_INT', 42, 6, 2, 0), 1, 1)
add('valueBytes', m.MAVLink_param_value_message(b'TEST_INT', struct.unpack('<f', struct.pack('<i', 42))[0], 6, 2, 0), 1, 1)
add('list', m.MAVLink_mission_request_list_message(1, 1, 0))
add('count', m.MAVLink_mission_count_message(1, 1, 2, 0))
add('request', m.MAVLink_mission_request_int_message(1, 1, 0, 0))
add('item', m.MAVLink_mission_item_int_message(1, 1, 0, 6, 16, 1, 1, 0, 2, 0, 90, 10000, 20000, 10, 0))
add('missionAck', m.MAVLink_mission_ack_message(1, 1, 0, 0))
add('current', m.MAVLink_mission_current_message(1, 2, 3, 1), 1, 1)
add('version', m.MAVLink_autopilot_version_message(8192 | 4 | 16, 0x010f0000, 0, 0, 1, [0]*8, [0]*8, [0]*8, 0, 0, 123, [0]*18), 1, 1)
heartbeat = m.MAVLink_heartbeat_message(2, 12, 129, 6 << 16, 4, 3)
add('signedHeartbeat', heartbeat, 1, 1, signed=True)
Path(__file__).with_name('wire.json').write_text(json.dumps({'generator': 'pymavlink 2.4.50 common v2, sequence 11', 'testSigningKey': 'bytes 0..31, public test vector only', 'packets': fixtures}, indent=2)+'\n')
