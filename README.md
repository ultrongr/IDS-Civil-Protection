# 🛰️ Civil Protection – Data Space–Driven Evacuation Coordination System

This repository contains the implementation of the **Civil Protection Demo Application**, a prototype developed as part of a Master’s Thesis.  
It demonstrates how **Data Spaces**, following **IDS (International Data Spaces)** standards, can enable **secure, interoperable, and real-time data exchange** between organizations for **disaster management and evacuation planning** — with a focus on assisting **people with disabilities**.

---

## 🧭 Overview

The project showcases a **Data Space ecosystem** and a **demo web application** that consumes data from multiple simulated APIs (government, clubs, fleet management, and natural disasters).  
It integrates and visualizes this data on a map, enabling a **Civil Protection operator** to:

- Monitor natural disasters and affected zones  
- View available emergency vehicles and people requiring assistance  
- Automatically plan evacuation routes  
- Dispatch instructions to vehicle operators  

This ecosystem was built upon the **IDS Reference Testbed**, extended with new connectors, APIs, and front-end services.


---

## 🧩 Components

### 🏛️ 1. Government Catalog API (Mhtroo)
Simulates a national registry of people with disabilities.  
- Built with **Node.js + MongoDB**  
- Data encrypted at rest using **AES-256-GCM**  
- Token-based access via Connector  
- Documented via **Swagger**

### 🧑‍🤝‍🧑 2. Amea Club API
Represents local clubs or municipalities managing smaller registries.  
- Built with **Node.js + SQL**  
- Connects to Data Space through its own connector  
- Provides encrypted, tokenized data streams

### 🚓 3. Fleet Generator
A **Python** service simulating emergency vehicles (ambulances, fire trucks, police).  
- Publishes real-time position and status data to **FIWARE Orion Context Broker**  
- Supports simulation of movement along routes  

### 🌋 4. Disasters API
Fetches real data from the **Copernicus EFFIS API** to simulate ongoing natural disasters.

### 🗺️ 5. Civil Protection Demo App
The main application — built with **Node.js**, **Leaflet**, and **Express** — serves as the **central operator dashboard**.  
Key functions:
- Securely connects to Data Space and decrypts incoming data  
- Visualizes entities on an interactive **OpenStreetMap** interface  
- Plans optimal evacuation using **Google Cloud Fleet Routing (CFR)** and **OpenRouteService (ORS)**  
- Sends personalized evacuation routes and notes to operators via **Nodemailer**

---

## 🛡️ Security and Data Sovereignty

The system ensures:
- **Encrypted data at rest and in transit** (AES-256-GCM)  
- **Token-based access control** through DAPS-issued Dynamic Attribute Tokens (DAT)  
- **Traceable and sovereign data flow**, where data never leaves provider control  
- **Metadata-based discovery** via IDS Broker  

---

## 🧰 Technologies

| Layer | Technologies |
|-------|---------------|
| **Backend** | Node.js, Express, Python |
| **Frontend** | HTML, CSS, Leaflet.js |
| **APIs & Data** | MongoDB, SQL, Swagger, FIWARE Orion |
| **Optimization** | Google Cloud Fleet Routing, ORS, OSRM |
| **Communication** | Nodemailer (SMTP) |
| **Security** | AES-256-GCM, CFSSL, OpenSSL |
| **Infrastructure** | Docker, IDS Reference Testbed, DAPS, Broker |


This project was developed as part of the Master’s Thesis:

Leveraging Data Spaces for Coordinated Disaster Response
University of Patras, Department of Electrical and Computer Engineering (2025)
Author: Konstantinos Tsampras
Supervisor: Prof. Spyros Denazis


