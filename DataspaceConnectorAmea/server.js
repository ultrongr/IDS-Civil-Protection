import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ameaRoutes from './routes/amea.js';
import fs from 'fs';
import https from 'https';
import express from 'express';


// Load your connector’s key and certificate (PEM format)
const options = {
  key: fs.readFileSync('certs/ConnectorAmea-key.pem'),
  cert: fs.readFileSync('certs/ConnectorAmea.pem'),
  // (Optional) include the testbed Root CA so outgoing requests (e.g. to DAPS) trust the chain
  ca: fs.readFileSync('certs/ca.crt') 
};



import Amea from './models/Amea.js';

dotenv.config({ path: './.env' });
// console.log("env loaded", process.env.MONGO_URI)
const app = express();
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// Routes
app.use('/api/amea', ameaRoutes);


app.get("/add-example", async (req, res) => {
  try {
    const amea = new Amea({
      name: "Maria",
      surname: "Nikolaou",
      email: { value: "maria@example.com", active: 1 },
      phoneNumber: { value: "6901234567", active: 1 },
      landNumber: { value: "2107654321", active: 0 },
      mandatoryCommunication: "phone",
      region: { administrative: "Central Macedonia", municipality: "Thessaloniki" },
      address: "456 Example Ave",
      status: "active",
      caretaker: {
        carename: "Ioannis",
        caresurname: "Koutras",
        careemail: "ioannis@example.com",
        carephone: "6981122334",
        caredescription: "Brother"
      }
    });

    await amea.save();
    res.status(201).json({ message: "Example Amea added successfully!" });
  } catch (error) {
    console.error("❌ Error adding example Amea:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


// Start HTTPS server on port 8080 (or 443) using the certs
https.createServer(options, app).listen(process.env.PORT, () => {
  console.log('Connector Amea is running');
});