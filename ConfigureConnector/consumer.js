import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config({ path: 'consumer.env' });

// Disable SSL verification for self-signed certificates
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Admin BASIC auth for connector management APIs
axios.defaults.auth = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
};

const app = express();
app.use(express.json());

const waitTime = 1; // ms

// Environment variables (non-sensitive)
const {
  PROVIDER_ALIAS,
  CONSUMER_URL,      // e.g. https://localhost:8081
  BROKER_API,        // e.g. https://broker-reverseproxy/infrastructure
  BROKER_REV_PROXY   // e.g. https://broker-reverseproxy
} = process.env;

console.log('Environment variables loaded:', {
  PROVIDER_ALIAS,
  CONSUMER_URL,
  BROKER_API,
  BROKER_REV_PROXY
});



// Small sleep helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  const summary = {};

  // 1. Consumer: Register consumer
  console.log('Registering consumer');
  await axios.post(
    `${CONSUMER_URL}/api/ids/connector/update`, null,
    { params: { recipient: BROKER_API } }
  );
  summary.registered_consumer = true;

  await sleep(waitTime);

  // 2. Check successful registration
  console.log('Checking registration');
  const regResp = await axios.post(
    `${CONSUMER_URL}/api/ids/description`, null,
    { params: { recipient: BROKER_API, elementId: `${BROKER_REV_PROXY}/connectors/` } }
  );
  summary.registrationResponse = regResp.data;
  

  await sleep(waitTime);

  // 3. Discover Catalog
  console.log('Discovering catalog');
  const descResp = await axios.post(
    `${CONSUMER_URL}/api/ids/description`, null,
    { params: { recipient: `${PROVIDER_ALIAS}/api/ids/data` } }
  );
//   console.log("self description", descResp.data);
  summary.discoveryResponse = descResp.data;

  const providerCatalog = descResp.data['ids:resourceCatalog'][0]['@id'];
  summary.providerCatalog = providerCatalog;

  await sleep(waitTime);

  // 4. Expand Catalog
  console.log('Expanding catalog');
  const expandResp = await axios.post(
    `${CONSUMER_URL}/api/ids/description`, null,
    { params: { recipient: `${PROVIDER_ALIAS}/api/ids/data`, elementId: providerCatalog } }
  );
  summary.expansionResponse = expandResp.data;

  const providerResource = expandResp.data['ids:offeredResource'][0]['@id'];
  const providerArtifact = expandResp.data['ids:offeredResource'][0]['ids:representation'][0]['ids:instance'][0]['@id'];
  const providerRule = expandResp.data['ids:offeredResource'][0]['ids:contractOffer'][0]['ids:permission'][0]['@id'];
  summary.providerResource = providerResource;
  summary.providerRule = providerRule;
  summary.providerRepresentation = expandResp.data['ids:offeredResource'][0]['ids:representation'][0]['@id'];
  summary.providerArtifact = providerArtifact;

  await sleep(waitTime);

  // 5. Negotiate Contract
  console.log('Negotiating contract');
  const permissions = [
    {
      '@type': 'ids:Permission',
      'ids:description': [
        { '@value': 'Usage policy provide access applied', '@type': 'http://www.w3.org/2001/XMLSchema#string' }
      ],
      'ids:title': [
        { '@value': 'Example Usage Policy', '@type': 'http://www.w3.org/2001/XMLSchema#string' }
      ],
      'ids:action': [{ '@id': 'https://w3id.org/idsa/code/USE' }],
      'ids:target': providerArtifact
    }
  ];

  const contractResp = await axios.post(
    `${CONSUMER_URL}/api/ids/contract`,
    permissions,
    {
      params: {
        recipient: `${PROVIDER_ALIAS}/api/ids/data`,
        resourceIds: providerResource,
        artifactIds: providerArtifact,
        download: false
      },
      headers: { 'Content-Type': 'application/ld+json' }
    }
  );
  
  const agreementHref = contractResp.data._links.self.href;
  const agreementId = agreementHref.split('/').pop();
  summary.agreementId = agreementId;

  await sleep(waitTime);

  // 6. Fetch Data Link
  console.log('Fetching data link');
  const dataLinkResp = await axios.get(`${CONSUMER_URL}/api/agreements/${agreementId}/artifacts`);
  const dataLink = dataLinkResp.data['_embedded']['artifacts'][0]['_links']['data']['href'];
  summary.dataLink = dataLink;

  await sleep(waitTime);

  // 7. Download Payload
  console.log('Downloading payload (secured JSON)');
  const payloadResp = await axios.get(dataLink);
  const payload = payloadResp.data;
  console.log('Secured config received (unredacted):', payload);

  // 8. Normalize & redact sensitive fields
  let config;
  if (typeof payload === 'string') {
    try { config = JSON.parse(payload); } catch { config = { _raw: '[non-JSON string payload]' }; }
  } else if (payload && typeof payload === 'object') {
    config = payload;
  } else {
    config = { _raw: '[unknown payload type]' };
  }

  const redacted = (() => {
    try {
      const clone = JSON.parse(JSON.stringify(config));
      if (clone?.auth?.token) clone.auth.token = '***REDACTED***';
      if (clone?.crypto?.secret) clone.crypto.secret = '***REDACTED***';
      return clone;
    } catch {
      return { _raw: '[unprintable config]', note: 'redaction applied' };
    }
  })();

  console.log('Secured config received (redacted):', JSON.stringify(redacted));
  console.log('Consumer flow completed successfully');

} catch (err) {
  console.log('error');
  console.error(err.response?.data || err.message);
}

// const PORT = process.env.PORT || 3001;
// app.listen(PORT, () => console.log(`Consumer app listening on port ${PORT}`));
