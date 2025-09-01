import express from 'express';
import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';

// Use the Civilservice env file
dotenv.config({ path: 'civilservice.env' });

// Disable SSL verification for self-signed certificates
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Global basic auth for all calls
axios.defaults.auth = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD
};

const app = express();
app.use(express.json());

const waitTime = 1; // ms

// Environment variables
const {
  PROVIDER_URL, PROVIDER_ALIAS, CONSUMER_URL, BROKER_API, BROKER_REV_PROXY,
  DATA_DOC_URL, 
  ADMIN_USERNAME, ADMIN_PASSWORD,

  // NEW
  ORION_BASE,
  FIWARE_SERVICE_PATH,
  FIWARE_SERVICE,          // optional
  FIWARE_RESOURCE_TYPE,    // e.g. Vehicle
  FIWARE_OPTIONS           // e.g. keyValues
} = process.env;


try {
  const summary = {};

  // 1. Create an Offer
  console.log('Creating offer');
  const offerResp = await axios.post(
    `${PROVIDER_URL}/api/offers`,
    {
      title: 'Civilservice Data Offer',
      description: `Civilservice NGSI v2 data from FIWARE Orion (${ORION_BASE}), servicePath: ${FIWARE_SERVICE_PATH}`,
      keywords: ['CIVILSERVICE', 'FIWARE', 'NGSIv2', FIWARE_RESOURCE_TYPE || '', 'Vehicles'],
      publisher: `${ORION_BASE}/v2/entities`,
      language: 'EN',
      sovereign: ORION_BASE,
      endpointDocumentation: DATA_DOC_URL || 'https://fiware-orion.readthedocs.io/en/latest/',
      paymentModality: 'undefined'
    }
  );

  console.log('Offer created:', offerResp.data);
  const offerUri = offerResp.data._links.self.href;
  summary.offerUri = offerUri;

  // 2. Create a Catalog
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Creating catalog');
  const catResp = await axios.post(
    `${PROVIDER_URL}/api/catalogs`,
    { title: 'Civilservice Data Catalog', description: 'Catalog for Civilservice offers' }
  );
  const catalogUri = catResp.data._links.self.href;
  summary.catalogUri = catalogUri;

  // 3. Link Offer → Catalog
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Linking offer to catalog');
  await axios.post(`${catalogUri}/offers`, [offerUri]);
  summary.catalogLinked = true;

  // 4. Create a rule
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Creating rule');
  const ruleResp = await axios.post(
    `${PROVIDER_URL}/api/rules`,
    {
      title: 'Example Usage Policy',
      description: 'Usage policy provide access applied',
      value:
        "{\n  \"@context\" : {\n    \"ids\" : \"https://w3id.org/idsa/core/\",\n    \"idsc\" : \"https://w3id.org/idsa/code/\"\n  },\n  \"@type\" : \"ids:Permission\",\n  \"@id\" : \"https://w3id.org/idsa/autogen/permission/51f5f7e4-f97f-4f91-bc57-b243714642be\",\n  \"ids:description\" : [ {\n    \"@value\" : \"Usage policy provide access applied\",\n    \"@type\" : \"http://www.w3.org/2001/XMLSchema#string\"\n  } ],\n  \"ids:title\" : [ {\n    \"@value\" : \"Example Usage Policy\",\n    \"@type\" : \"http://www.w3.org/2001/XMLSchema#string\"\n  } ],\n  \"ids:action\" : [ { \"@id\" : \"https://w3id.org/idsa/code/USE\" } ]\n }"
    }
  );
  const ruleUri = ruleResp.data._links.self.href;
  summary.policyruleUri = ruleUri;

  // 5. Create a Contract template that uses that rule
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Creating contract template');
  const cdResp = await axios.post(
    `${PROVIDER_URL}/api/contracts`,
    {
      title: 'Contract',
      description: 'Contract for sharing Civilservice data',
      provider: PROVIDER_ALIAS,
      start: '2023-10-22T07:48:37.068Z',
      end: '2028-10-22T07:48:37.068Z'
    }
  );
  const contractUri = cdResp.data._links.self.href;
  summary.contractDefinitionId = contractUri;

  // 6. Add rule to contract template
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Adding rule to contract template');
  await axios.post(`${contractUri}/rules`, [ruleUri]);
  summary.contractLinked = true;

  // 7. Create Artifact (proxy to your data API)
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Creating artifact');
  // Build a JSON payload that documents how to reach Orion
  const artifactConfig = {
    backend: 'fiware-ngsi-v2',
    orionBase: ORION_BASE,                 // e.g. http://150.140.186.118:1026
    servicePath: FIWARE_SERVICE_PATH,      // e.g. /up1083865/thesis/Vehicles
    service: FIWARE_SERVICE || null,       // optional tenant
    resourceType: FIWARE_RESOURCE_TYPE || 'Vehicle',
    options: FIWARE_OPTIONS || 'keyValues',
    // purely informative — Orion expects these as HTTP headers
    requiredHeaders: {
      'Fiware-ServicePath': FIWARE_SERVICE_PATH,
      ...(FIWARE_SERVICE ? { 'Fiware-Service': FIWARE_SERVICE } : {})
    }
  };

  const artResp = await axios.post(
    `${PROVIDER_URL}/api/artifacts`,
    {
      title: 'Civilservice FIWARE Config',
      description: `Connection info for Orion ${ORION_BASE} [${FIWARE_SERVICE_PATH}]`,
      value: JSON.stringify(artifactConfig, null, 2),  // <= JSON as string
      automatedDownload: false                          // <= do NOT try to fetch a URL
    }
  );

  const artifactUri = artResp.data._links.self.href;
  summary.artifactUri = artifactUri;

  // 8. Create Representation
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Creating representation');
  const reprResp = await axios.post(
    `${PROVIDER_URL}/api/representations`,
    {
      title: 'Civilservice JSON Representation',
      mediaType: 'application/json',
      language: 'https://w3id.org/idsa/code/EN'
    }
  );
  const reprUri = reprResp.data._links.self.href;
  summary.reprUri = reprUri;

  // 9. Link Representation → Artifact
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Linking representation to artifact');
  await axios.post(`${reprUri}/artifacts`, [artifactUri]);

  // 10. Link Representation → Offer
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Linking representation to offer');
  await axios.post(`${offerUri}/representations`, [reprUri]);
  summary.repLinked = true;

  // 11. Add contract to offer
  await new Promise((res) => setTimeout(res, waitTime));
  console.log('Linking contract to offer');
  await axios.post(`${offerUri}/contracts`, [contractUri]);
  summary.offerContractLinked = true;

  // Wait for broker to update
  await new Promise((res) => setTimeout(res, waitTime));

  console.log('All URIs:');
  console.log('Offer URI:', offerUri);
  console.log('Catalog URI:', catalogUri);
  console.log('Rule URI:', ruleUri);
  console.log('Contract Definition URI:', contractUri);
  console.log('Artifact URI:', artifactUri);
  console.log('Representation URI:', reprUri);

  // 12. Register provider connector at broker
  console.log('Registering provider');
  await axios.post(
    `${PROVIDER_URL}/api/ids/connector/update`,
    null,
    { params: { recipient: BROKER_API } }
  );
  summary.registered = true;

  await new Promise((res) => setTimeout(res, waitTime));

  // 13. Consumer: Register consumer
  console.log('Registering consumer');
  await axios.post(
    `${CONSUMER_URL}/api/ids/connector/update`,
    null,
    { params: { recipient: BROKER_API } }
  );
  summary.registered_consumer = true;

  await new Promise((res) => setTimeout(res, waitTime));

  // 14. Check successful registration
  console.log('Checking registration');
  const regResp = await axios.post(
    `${CONSUMER_URL}/api/ids/description`,
    null,
    { params: { recipient: BROKER_API, elementId: `${BROKER_REV_PROXY}/connectors/` } }
  );
  summary.registrationResponse = regResp.data;

  await new Promise((res) => setTimeout(res, waitTime));

  // 15. Consumer: Discover Catalog of the provider (Civilservice)
  console.log('Discovering catalog');
  const descResp = await axios.post(
    `${CONSUMER_URL}/api/ids/description`,
    null,
    { params: { recipient: `${PROVIDER_ALIAS}/api/ids/data` } } // e.g. https://connectorcivilservice:8084/api/ids/data
  );

  // Find the catalog that matches what we just created
  let catalogIndex = 0;
  for (let i = 0; i < descResp.data['ids:resourceCatalog'].length; i++) {
    if (String(descResp.data['ids:resourceCatalog'][i]['@id']).slice(-10) === String(catalogUri).slice(-10)) {
      catalogIndex = i;
      break;
    }
  }
  const providerCatalog = descResp.data['ids:resourceCatalog'].at(catalogIndex)['@id'];
  summary.providerCatalog = providerCatalog;

  await new Promise((res) => setTimeout(res, waitTime));

  // 16. Expand Catalog in Consumer
  console.log('Expanding catalog');
  const expandResp = await axios.post(
    `${CONSUMER_URL}/api/ids/description`,
    null,
    { params: { recipient: `${PROVIDER_ALIAS}/api/ids/data`, elementId: providerCatalog } }
  );

  const providerResource = expandResp.data['ids:offeredResource'][0]['@id'];
  const providerArtifact = expandResp.data['ids:offeredResource'][0]['ids:representation'][0]['ids:instance'][0]['@id'];
  const providerRule = expandResp.data['ids:offeredResource'][0]['ids:contractOffer'][0]['ids:permission'][0]['@id'];
  summary.providerResource = providerResource;
  summary.providerRule = providerRule;
  summary.providerRepresentation = expandResp.data['ids:offeredResource'][0]['ids:representation'][0]['@id'];
  summary.providerArtifact = providerArtifact;

  // 17. Negotiate Contract
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

  // 18. Fetch Data Link
  console.log('Fetching data link');
  const dataLinkResp = await axios.get(
    `${CONSUMER_URL}/api/agreements/${agreementId}/artifacts`
  );
  const dataLink = dataLinkResp.data['_embedded']['artifacts'][0]['_links']['data']['href'];
  summary.dataLink = dataLink;

  // 19. Download payload
  const payloadResp = await axios.get(dataLink);
  const payload = payloadResp.data;

  // 20. If it’s a URL, fetch it; if it’s JSON, just log/use it
  let data;
  if (typeof payload === 'string' && /^https?:\/\//.test(payload)) {
    data = (await axios.get(payload)).data;
  } else if (typeof payload === 'string') {
    try { data = JSON.parse(payload); } catch { data = payload; }
  } else {
    data = payload;
  }
  console.log('Payload (truncated):', JSON.stringify(data).slice(0, 400), '...');

} catch (err) {
  console.log('error');
  console.error(err.response?.data || err.message);
}

// const PORT = process.env.PORT || 3001;
// app.listen(PORT, () => console.log(`Simulation app listening on port ${PORT}`));
