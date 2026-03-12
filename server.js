'use strict';
const app = require('./api/index.js');
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 3000;

// Servindo arquivos estáticos apenas no modo local
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`\n============================`);
    console.log(` Surebet Manager - LOCAL SERVER `);
    console.log(` http://localhost:${PORT}`);
    console.log(`============================\n`);
});
