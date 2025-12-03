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

let indexKey = 0
server.use(middlewares)
// Add this before server.use(router)
server.use(jsonServer.rewriter({
    '/api/*': '/$1',
    '/blog/:resource/:id/show': '/:resource/:id'
}))

server.get('/oxford', async (req, res) => {

    let { word } = req.query;
    word = word.toLowerCase().trim();

    const URL = `https://www.oxfordlearnersdictionaries.com/definition/english/${word}_1?q=${word}`;
    // const URL= "https://www.oxfordlearnersdictionaries.com/definition/english/red_1?q=red"
    console.log(URL);
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
        const proUKList = Array.from(document.querySelectorAll('.headword ~ .phonetics   .sound.audio_play_button.pron-uk.icon-audio ~ .phon'));
        const proUSList = Array.from(document.querySelectorAll('.headword ~ .phonetics   .sound.audio_play_button.pron-us.icon-audio ~ .phon'));

        const UKAudioList = Array.from(document.querySelectorAll('span .sound.audio_play_button.pron-uk'));
        const USAudioList = Array.from(document.querySelectorAll('span .sound.audio_play_button.pron-us'));

        const wordLevelList = Array.from(document.querySelectorAll('.symbols a'));
        let wordMeaningList = Array.from(document.querySelectorAll(".senses_multiple .def"));

        console.log("==>",wordMeaningList.length)

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

    // config param logic
    const maxLengthWord = 20;
    let flagFailCount = 0;
    let maxFailCount = 4;

    // AI param
    const AI_KEY_LIST = process.env.APIKEY.split(' ');
    const AI_KEY_LENGTH = AI_KEY_LIST.length;
    const AI_MODEL = "gemini-2.5-flash";
    const INSTRUCTION = `
        ${word} analyze and maintain the order of syllables: onset, nucleus, coda
        
        Your must follow the rule before get the final result 
        ORDER OF PRIORITY OF SYLLABLE SEPARATION RULES
            1/Short vowel contraint(SVC)
            1.1/Apply for nucleus: /ɒ, æ, ʊ, ɪ, ɛ/ carry primary stress
            If syllabel include short vowel is stress, nucleus will have coda 
            1.2/Choose coda rule:
            - Single Coda
            - Double/Triple Coda (If valid, let the remaining consonant be the Onset of the next syllable)
            1.3/Purpose: Keep short vowels “checked”, avoid prolongation
            1.4/Example 
            - /ˈkæ.tə/ → incorrect if using MOP → correct: /ˈkæt.ə/ (because /æ/ has stress → must be closed)
            - /ˈæ.tləs/ → /æt/ closed Coda /t/

            2/Stressed Open Vowel Constraint (SOVC) 
            2.1/Apply for nucleus: Open/long vowels (e.g. /ɑː, ɜː, ɔː/) carry primary stress
            Syllables containing open vowels have stress so there should be a Coda for the closed syllable.
            2.2/Choose coda rule:
            - Single Coda
            - Double/Triple Coda (If valid, let the remaining consonant be the Onset of the next syllable)
            2.3/ Example
            /ˈfɑː.mə/ → /ɑː/ to carry stress → to close → /ˈfɑːm.ə/
            /ˈɜː.rɪŋ/ → /ɜː/ to carry stress → /ˈɜːr.ɪŋ/

            3/Maximal Onset Principle (MOP)
            3.1/ Apply for nucleus: The nucleus is NOT short vowel or Short vowel but NOT with main stress
            3.2/ Rule: Push the consonant to the next syllable's Onset as much as possible, as long as the Onset is valid in English
            3.3/ Example
            /ˌkæ.təˈstɹɒ.fɪk/: /æ/ is not stressed → apply MOP → /t/ pushes to onset /tə/
            /ˌɪn.təˈnæʃ.ə.nəl/ → unstressed following consonant /ə/ → pushed to onset: ɪn.tə.næʃ.ə.nəl

            4/Consonant Cluster Constraint (CCC) 
            4.1/ Apply for nucleus: When there is a consonant string >1 after the vowel that requires Coda
            4.2/ Rules:
            - Choose the longest valid Coda (maximal valid coda cluster) in English.
            - The rest of the string is the Onset of the next syllable, as long as it is valid.
            - If it cannot be split validly → take C₁ as Coda, the rest as Onset.
            4.3/ Example:/kəˈtæstrəfi/
            - String after /æ/ = /str/
            - Find maximal valid Coda cluster → valid /st/ → /tæst/
            - Remainder = /r/ → onset syllable 2 → /rə/
            - Result: /kəˈtæst.rə.fi/
        Return a json following format
            [
                {
                  "index": 1,
                  "onset": "/v/",
                  "nucleus": "/ɜː/",
                  "coda": null,
                  "syllable:  "/vɜː/"
                },
                {
                  "syllable_number": 2,
                  "onset": "/ʃ/",
                  "nucleus": "/n/",
                  "coda": null,
                  "syllable:  "/ʃn/"
                }
            ]      
      Output requirement:
        Return only one JSON object — the updated version containing the completed syllableArray.
        Must be Syllable = onset + nucleus + coda (check carefullly)
        No additional explanations, text, or formatting are allowed outside the JSON object.
      `;

    // input
    word = word.toLowerCase().trim();
    indexKey++;
    indexKey = (indexKey % AI_KEY_LENGTH)

    // debug
    console.log("indexKey===> ", indexKey)

    while (flagFailCount < maxFailCount) {
        try {
            if (word.length > maxLengthWord) {
                res.send({
                    text: `Max length ${maxLengthWord} characters`
                });
            }
            const ai = new GoogleGenAI({ apiKey: AI_KEY_LIST[indexKey] });
            const response = await ai.models.generateContent({
                model: AI_MODEL,
                contents: INSTRUCTION,
                config: {
                    temperature: 0
                }
            });

            if (response.text) {
                const CLEANUP_REGEX = /^\s*```json\s*|\s*```\s*$/g;
                const jsonString = JSON.parse(response.text.replace(CLEANUP_REGEX, ''));

                res.send({
                    jsonString
                });
                break;
            }
        } catch (error) {
            console.error("Fetch error:", error);
            flagFailCount++;
            indexKey = (indexKey + 1 % AI_KEY_LENGTH)
            if (flagFailCount == maxFailCount) {
                res.status(500).send({ message: error.message });
            }
        }
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
