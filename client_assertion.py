import jwt
import time
import uuid
connectorA_key_path = "/home/kostas/Desktop/IDS-testbed/CertificateAuthority/data-cfssl/certs/connectorA-key.pem"
connectorA_client_id = "EB:D2:46:C7:7A:B8:DC:48:9D:AB:1D:31:2A:08:41:48:D7:5F:12:55:keyid:C4:76:D0:AA:CD:93:79:35:0F:EB:A7:64:60:90:A4:6B:B4:38:4D:33"
private_key = open(connectorA_key_path).read()
client_id = 'your_client_id'
token_endpoint = 'https://localhost/token'

now = int(time.time())
payload = {
    'iss': client_id,
    'sub': client_id,
    'aud': token_endpoint,
    'jti': str(uuid.uuid4()),
    'iat': now,
    'exp': now + 30000  # 500 minutes from now
}

headers = {
    'alg': 'RS256',
    'typ': 'JWT'
}

client_assertion = jwt.encode(payload, private_key, algorithm='RS256', headers=headers)
print(client_assertion)


connectorA_client_assertion = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ5b3VyX2NsaWVudF9pZCIsInN1YiI6InlvdXJfY2xpZW50X2lkIiwiYXVkIjoiaHR0cHM6Ly9sb2NhbGhvc3QvdG9rZW4iLCJqdGkiOiIxM2EzNGIwNi1jMzY0LTQxYmQtOTZlYy03OGEyY2NiMTczODQiLCJpYXQiOjE3NDkxMzMzNjMsImV4cCI6MTc0OTE2MzM2M30.c3q52bT0WtMvRzwdUTkZ7zexkgcYh8pbq1f1PISLl-fKjiuKsm4wjISJfpy8fgDtdRiG4l_Mcs0OFrLzk6srWxVMNZyeCtygH1R_k0U_k2Nnkx-ddkgz7J4Wd0Bzr7pf5U9w-vLaQE8IMXtcVUjGBmc4sDk2OaiNFM_ilGY_rIWV6ce3fMwDuqsFE79IIeZYwiWZ-EXU_wfxpXb0gWfB2aigKrx73jnSGGJJn9WZsVo5do5xITkkOZ7kzZPwbwM1QAOgrqx1exd2LUW2n6RuVAsy9NETT44ihU72xgcxdfSSI5WfsviUd-VSoHokpiJDsPr4o3BaJnJAVBnwkCsB3g"


"""
curl -k -X POST https://localhost/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=EB:D2:46:C7:7A:B8:DC:48:9D:AB:1D:31:2A:08:41:48:D7:5F:12:55:keyid:C4:76:D0:AA:CD:93:79:35:0F:EB:A7:64:60:90:A4:6B:B4:38:4D:33" \
  --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data-urlencode "client_assertion=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ5b3VyX2NsaWVudF9pZCIsInN1YiI6InlvdXJfY2xpZW50X2lkIiwiYXVkIjoiaHR0cHM6Ly9sb2NhbGhvc3QvdG9rZW4iLCJqdGkiOiIxM2EzNGIwNi1jMzY0LTQxYmQtOTZlYy03OGEyY2NiMTczODQiLCJpYXQiOjE3NDkxMzMzNjMsImV4cCI6MTc0OTE2MzM2M30.c3q52bT0WtMvRzwdUTkZ7zexkgcYh8pbq1f1PISLl-fKjiuKsm4wjISJfpy8fgDtdRiG4l_Mcs0OFrLzk6srWxVMNZyeCtygH1R_k0U_k2Nnkx-ddkgz7J4Wd0Bzr7pf5U9w-vLaQE8IMXtcVUjGBmc4sDk2OaiNFM_ilGY_rIWV6ce3fMwDuqsFE79IIeZYwiWZ-EXU_wfxpXb0gWfB2aigKrx73jnSGGJJn9WZsVo5do5xITkkOZ7kzZPwbwM1QAOgrqx1exd2LUW2n6RuVAsy9NETT44ihU72xgcxdfSSI5WfsviUd-VSoHokpiJDsPr4o3BaJnJAVBnwkCsB3g"
"""