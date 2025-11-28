// See https://github.com/typicode/json-server#module
const jsonServer = require('json-server')
const axios = require('axios');
const cron = require('node-cron'); // Cài đặt cronJob
const { parseHTML } = require('linkedom');
const server = jsonServer.create()
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

// Uncomment to allow write operations
// const fs = require('fs')
// const path = require('path')
// const filePath = path.join('db.json')
// const data = fs.readFileSync(filePath, "utf-8");
// const db = JSON.parse(data);
// const router = jsonServer.router(db)

// Comment out to allow write operations
const router = jsonServer.router('db.json')

const middlewares = jsonServer.defaults()

server.use(middlewares)
// Add this before server.use(router)
server.use(jsonServer.rewriter({
    '/api/*': '/$1',
    '/blog/:resource/:id/show': '/:resource/:id'
}))

server.get('/oxford', async (req, res) => {

    let { word } = req.query;
    word = word.toLowerCase.trim;
    const URL = `https://www.oxfordlearnersdictionaries.com/definition/english/${word}_1?q=${word}`;
    // const URL= "https://www.oxfordlearnersdictionaries.com/definition/english/red_1?q=red"
    try {
        const response = await fetch(
            URL,
            {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Accept": "text/html",
                },
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const html = await response.text();
        let dataSyllableOxford = [];

        // craw data from html
        const { document } = parseHTML(html);
        const proUKList = Array.from(document.querySelectorAll('.symbols ~ .phonetics   .sound.audio_play_button.pron-uk.icon-audio ~ .phon'));
        const proUSList = Array.from(document.querySelectorAll('.symbols ~ .phonetics   .sound.audio_play_button.pron-us.icon-audio ~ .phon'));

        const UKAudioList = Array.from(document.querySelectorAll('span .sound.audio_play_button.pron-uk'));
        const USAudioList = Array.from(document.querySelectorAll('span .sound.audio_play_button.pron-us'));

        const wordLevelList = Array.from(document.querySelectorAll('.symbols a'));
        let wordMeaningList = Array.from(document.querySelectorAll('.shcut-g span.def'));

        wordMeaningList = wordMeaningList.map((word) => word.textContent);

        // get world level
        let wordLevel = null;
        if (wordLevelList.length > 0) {
            wordLevelString = wordLevelList[0].getAttribute("href");
            let levelIndex = wordLevelString.lastIndexOf("level=") + 6;
            wordLevel = wordLevelString.substring(levelIndex, levelIndex + 2);
        }

        // get word meaning
        let wordMening;

        // get sylable
        proUKList.forEach((pro, index) => {
            // console.log("map===>",)
            let syllableData = {
                ipaTranscription: pro.textContent ?? "",
                audio: UKAudioList.length > 0 ? (UKAudioList[index].getAttribute("data-src-mp3") ?? "") : "",
                typeUSOrUK: "UK",
                syllableArray: []
            };
            dataSyllableOxford.push(syllableData);
        });
        proUSList.forEach((pro, index) => {
            let syllableData = {
                ipaTranscription: pro.textContent ?? "",
                audio: USAudioList.length > 0 ? (USAudioList[index].getAttribute("data-src-mp3") ?? "") : "",
                typeUSOrUK: "US",
                syllableArray: []
            };
            dataSyllableOxford.push(syllableData);
        });

        res.send({
            dataSyllableOxford,
            wordLevel,
            wordMeaningList
        });
    } catch (error) {
        console.error("Fetch error:", error);
        res.status(500).send({ message: error.message });
    }

});



server.get('/gemini', async (req, res) => {
    let { word } = req.query;
    word = word.toLowerCase().trim();   
    console.log("===> ",word)
    try {
        if (word.length > 20) {
            res.send({
                text: "Max length 10 characters"
            });
        }
        const INSTRUCTION = `
        ${word} analyze and maintain the order of syllables: onset, nucleus, coda
          Return a json following format
            [
                {
                  "index": 1,
                  "onset": "/v/",
                  "nucleus": "/ɜː/",
                  "coda": null,
                  "syllables:  "/vɜː/"
                },
                {
                  "syllable_number": 2,
                  "onset": "/ʃ/",
                  "nucleus": "/n/",
                  "coda": null,
                  "syllables:  "/ʃn/"
                }
            ]

      Output requirement:
        Return only one JSON object — the updated version containing the completed syllableArray.
        No additional explanations, text, or formatting are allowed outside the JSON object.
      `;

        const ai = new GoogleGenAI({ apiKey: process.env.APIKEY});
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: INSTRUCTION,
            // config: {
            //     systemInstruction: INSTRUCTION,
            // }
        });

        if (response.text) {
            const CLEANUP_REGEX = /^\s*```json\s*|\s*```\s*$/g;
            const jsonString = JSON.parse(response.text.replace(CLEANUP_REGEX, ''));

            res.send({
                jsonString
            });
        }

    } catch (error) {
        console.error("Fetch error:", error);
        res.status(500).send({ message: error.message });
    }
})

cron.schedule('*/10 * * * *', () => {
    console.log('Cron job running every 10 minutes');

    // Gửi một request bất kỳ tới server (có thể thay đổi endpoint)
    axios.get('https://be-dictionary.onrender.com/quiz2')
        .then(response => {
            console.log('Data received:', response.data);
        })
        .catch(error => {
            console.error('Error during axios request:', error);
        });
});
server.use(router)
server.listen(3000, () => {
    console.log('JSON Server is running')
})

// Export the Server API
module.exports = server
