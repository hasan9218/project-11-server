const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
// Connect MongoDB later
app.get('/', (req, res) => res.send('Server running'));
app.listen(process.env.PORT, () => console.log('Server on port', process.env.PORT));