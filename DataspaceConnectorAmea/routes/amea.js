import express from 'express';
import Amea from '../models/Amea.js';

const router = express.Router();

// GET all AMEA entries
router.get('/', async (req, res) => {
  try {
    const entries = await Amea.find();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST new AMEA entry
router.post('/', async (req, res) => {
  try {
    const newAmea = new Amea(req.body);
    const saved = await newAmea.save();
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});



export default router;