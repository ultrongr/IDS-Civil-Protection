import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config({ path: 'mhtroo.env' });

// Disable SSL verification for self-signed certificates (connectors often use self-signed TLS)
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Global BASIC auth for connector admin APIs (NOT used for your data APIs)
axios.defaults.auth = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
};

const app = express();
app.use(express.json());

const waitTime = 1; // ms pacing

// Environment variables
const {
  PROVIDER_URL,
  PROVIDER_ALIAS,
  CONSUMER_URL,
  BROKER_API,
  BROKER_REV_PROXY,
  DATA_API_URL, 
} = process.env;

// Sensitive secrets (read only; never log)
const AMEA_ACCESS_TOKEN =
  process.env.AMEA_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
const AMEA_DECRYPTION_SECRET =
  process.env.AMEA_DECRYPTION_SECRET || process.env.DECRYPTION_SECRET;

// Fail fast if secrets are missing
if (!AMEA_ACCESS_TOKEN || !AMEA_DECRYPTION_SECRET) {
  throw new Error(
    'Missing AMEA_ACCESS_TOKEN/AMEA_DECRYPTION_SECRET (or ACCESS_TOKEN/DECRYPTION_SECRET) in mhtroo.env'
  );
}

// Helper to extract HATEOAS href
function href(linkObj) {
  return linkObj.href || linkObj;
}

// Small wait helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  const summary = {};

  // 1. Create an Offer
  console.log('Creating offer');
  const offerResp = await axios.post(
    `${PROVIDER_URL}/api/offers`,
    {
      title: 'Amea Data Offer',
      description:
        'Directory of Amea entries (secured access; configuration delivered as JSON artifact)',
      keywords: ['AMEA', 'directory', 'secured'],
      publisher: DATA_API_URL,
      language: 'EN',
      sovereign: DATA_API_URL,
      endpointDocumentation: DATA_API_URL,
      paymentModality: 'undefined',
    },
    { baseURL: PROVIDER_URL }
  );
  const offerUri = offerResp.data._links.self.href;
  summary.offerUri = offerUri;

  // 2. Create a Catalog
  await sleep(waitTime);
  console.log('Creating catalog');
  const catResp = await axios.post(`${PROVIDER_URL}/api/catalogs`, {
    title: 'Amea Data Catalog',
    description: 'Catalog for Amea offers',
  });
  const catalogUri = catResp.data._links.self.href;
  summary.catalogUri = catalogUri;

  // 3. Link Offer → Catalog
  await sleep(waitTime);
  console.log('Linking offer to catalog');
  await axios.post(`${catalogUri}/offers`, [offerUri]);
  summary.catalogLinked = true;

  // 4. Create a rule (so the connector will accept contracts)
  await sleep(waitTime);
  console.log('Creating rule');
  const ruleResp = await axios.post(`${PROVIDER_URL}/api/rules`, {
    title: 'Example Usage Policy',
    description: 'Usage policy provide access applied',
    value:
      '{\n  "@context" : {\n    "ids" : "https://w3id.org/idsa/core/",\n    "idsc" : "https://w3id.org/idsa/code/"\n  },\n  "@type" : "ids:Permission",\n  "@id" : "https://w3id.org/idsa/autogen/permission/51f5f7e4-f97f-4f91-bc57-b243714642be",\n  "ids:description" : [ {\n    "@value" : "Usage policy provide access applied",\n    "@type" : "http://www.w3.org/2001/XMLSchema#string"\n  } ],\n  "ids:title" : [ {\n    "@value" : "Example Usage Policy",\n    "@type" : "http://www.w3.org/2001/XMLSchema#string"\n  } ],\n    "ids:action" : [ {\n    "@id" : "https://w3id.org/idsa/code/USE"\n  } ]\n }',
  });
  const ruleUri = ruleResp.data._links.self.href;
  summary.policyruleUri = ruleUri;

  // 5. Create a Contract template that uses that rule
  await sleep(waitTime);
  console.log('Creating contract template');
  const cdResp = await axios.post(`${PROVIDER_URL}/api/contracts`, {
    title: 'Contract',
    description: 'Contract for sharing AMEA data',
    provider: PROVIDER_ALIAS,
    start: '2023-10-22T07:48:37.068Z',
    end: '2028-10-22T07:48:37.068Z',
  });
  const contractUri = cdResp.data._links.self.href;
  summary.contractDefinitionId = contractUri;

  // 6. Add rule to contract template
  await sleep(waitTime);
  console.log('Adding rule to contract template');
  await axios.post(`${contractUri}/rules`, [ruleUri]);
  summary.contractLinked = true;

  // 7. Create Artifact — JSON payload with token + decryption secret (DO NOT LOG)
  await sleep(waitTime);
  console.log('Creating artifact (secured JSON)');

  // Build a minimal, self-describing secured config object
  const artifactConfig = {
    type: 'secured-config',
    version: 1,
    endpoint: DATA_API_URL, // upstream data API (no secrets in URL)
    auth: {
      scheme: 'Bearer',
      token: AMEA_ACCESS_TOKEN, // sensitive
    },
    crypto: {
      alg: 'AES-256-GCM',
      secret: AMEA_DECRYPTION_SECRET, // sensitive
      // You can add iv/nonce rotation guidance if your consumer uses envelope encryption
      encoding: 'utf8',
    },
    meta: {
      service: 'amea',
      issuedAt: new Date().toISOString(),
      note: 'Confidential. Do not log/store in plaintext.',
    },
  };

  const artResp = await axios.post(`${PROVIDER_URL}/api/artifacts`, {
    title: 'Amea Secured Config Artifact',
    description:
      'JSON configuration containing access token and decryption secret for AMEA data access',
    value: JSON.stringify(artifactConfig), // JSON as string; provider will deliver as-is
    automatedDownload: false, // not a URL fetch; deliver literal JSON
  });
  const artifactUri = artResp.data._links.self.href;
  summary.artifactUri = artifactUri;

  // 8. Create Representation
  await sleep(waitTime);
  console.log('Creating representation');
  const reprResp = await axios.post(`${PROVIDER_URL}/api/representations`, {
    title: 'Amea JSON Representation',
    mediaType: 'application/json',
    language: 'https://w3id.org/idsa/code/EN',
  });
  const reprUri = reprResp.data._links.self.href;
  summary.reprUri = reprUri;

  // 9. Link Representation → Artifact
  await sleep(waitTime);
  console.log('Linking representation to artifact');
  await axios.post(`${reprUri}/artifacts`, [artifactUri]);

  // 10. Link Representation → Offer
  await sleep(waitTime);
  console.log('Linking representation to offer');
  await axios.post(`${offerUri}/representations`, [reprUri]);
  summary.repLinked = true;

  // 11. Add contract to offer
  await sleep(waitTime);
  console.log('Linking contract to offer');
  await axios.post(`${offerUri}/contracts`, [contractUri]);
  summary.offerContractLinked = true;

  // Wait for broker to update
  await sleep(waitTime);

  console.log('All URIs:');
  console.log('Offer URI:', offerUri);
  console.log('Catalog URI:', catalogUri);
  console.log('Rule URI:', ruleUri);
  console.log('Contract Definition URI:', contractUri);
  console.log('Artifact URI:', artifactUri);
  console.log('Representation URI:', reprUri);

  // 12. Register provider connector at broker
  console.log('Registering provider');
  await axios.post(`${PROVIDER_URL}/api/ids/connector/update`, null, {
    params: { recipient: BROKER_API },
  });
  summary.registered = true;

  // Wait for broker to update
  await sleep(waitTime);

  // 13. Consumer: Register consumer
  console.log('Registering consumer');
  await axios.post(`${CONSUMER_URL}/api/ids/connector/update`, null, {
    params: { recipient: BROKER_API },
  });
  summary.registered_consumer = true;

  // Wait for broker to update
  await sleep(waitTime);

  // 14. Check successful registration
  console.log('Checking registration');
  const regResp = await axios.post(`${CONSUMER_URL}/api/ids/description`, null, {
    params: {
      recipient: BROKER_API,
      elementId: `${BROKER_REV_PROXY}/connectors/`,
    },
  });
  summary.registrationResponse = regResp.data;

  // Wait for broker to update
  await sleep(waitTime);

  // 15. Consumer: Discover Catalog
  console.log('Discovering catalog');
  const descResp = await axios.post(`${CONSUMER_URL}/api/ids/description`, null, {
    params: { recipient: `${PROVIDER_ALIAS}/api/ids/data` },
  });

  let catalogIndex = 0;
  for (let i = 0; i < descResp.data['ids:resourceCatalog'].length; i++) {
    if (
      String(descResp.data['ids:resourceCatalog'][i]['@id']).slice(-10) ===
      String(catalogUri).slice(-10)
    ) {
      catalogIndex = i;
      break;
    }
  }
  const providerCatalog =
    descResp.data['ids:resourceCatalog'].at(catalogIndex)['@id'];
  summary.providerCatalog = providerCatalog;

  // Wait for broker to update
  await sleep(waitTime);

  // 16. Expand Catalog in Consumer
  console.log('Expanding catalog');
  const expandResp = await axios.post(`${CONSUMER_URL}/api/ids/description`, null, {
    params: { recipient: `${PROVIDER_ALIAS}/api/ids/data`, elementId: providerCatalog },
  });

  const providerResource = expandResp.data['ids:offeredResource'][0]['@id'];
  const providerArtifact =
    expandResp.data['ids:offeredResource'][0]['ids:representation'][0]['ids:instance'][0]['@id'];
  const providerRule =
    expandResp.data['ids:offeredResource'][0]['ids:contractOffer'][0]['ids:permission'][0]['@id'];
  summary.providerResource = providerResource;
  summary.providerRule = providerRule;
  summary.providerRepresentation =
    expandResp.data['ids:offeredResource'][0]['ids:representation'][0]['@id'];
  summary.providerArtifact = providerArtifact;

  // 17. Negotiate Contract
  console.log('Negotiating contract');
  const permissions = [
    {
      '@type': 'ids:Permission',
      'ids:description': [
        {
          '@value': 'Usage policy provide access applied',
          '@type': 'http://www.w3.org/2001/XMLSchema#string',
        },
      ],
      'ids:title': [
        { '@value': 'Example Usage Policy', '@type': 'http://www.w3.org/2001/XMLSchema#string' },
      ],
      'ids:action': [{ '@id': 'https://w3id.org/idsa/code/USE' }],
      'ids:target': providerArtifact,
    },
  ];

  const contractResp = await axios.post(`${CONSUMER_URL}/api/ids/contract`, permissions, {
    params: {
      recipient: `${PROVIDER_ALIAS}/api/ids/data`,
      resourceIds: providerResource,
      artifactIds: providerArtifact,
      download: false,
    },
    headers: { 'Content-Type': 'application/ld+json' },
  });

  const agreementHref = contractResp.data._links.self.href;
  const agreementId = agreementHref.split('/').pop();
  summary.agreementId = agreementId;

  // 18. Fetch Data Link
  console.log('Fetching data link');
  const dataLinkResp = await axios.get(
    `${CONSUMER_URL}/api/agreements/${agreementId}/artifacts`
  );
  const dataLink = dataLinkResp.data._embedded.artifacts[0]._links.data.href;
  summary.dataLink = dataLink;

  // 19. Download Payload (JSON string expected). Do NOT log secrets.
  console.log('Downloading payload (secured JSON)');
  const payloadResp = await axios.get(dataLink);
  const payload = payloadResp.data;

  // 20. Normalize & parse without leaking secrets
  let config;
  if (typeof payload === 'string') {
    try {
      config = JSON.parse(payload);
    } catch {
      config = { _raw: '[non-JSON string payload received]' };
    }
  } else if (payload && typeof payload === 'object') {
    config = payload;
  } else {
    config = { _raw: '[unknown payload type]' };
  }

  // Redact before logging anything
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

  console.log('Simulation completed successfully');
} catch (err) {
  console.log('error');
  console.error(err.response?.data || err.message);
}

// const PORT = process.env.PORT || 3001;
// app.listen(PORT, () => console.log(`Simulation app listening on port ${PORT}`));
