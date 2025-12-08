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

let indexKey = 0;
const maxLengthWord = 20;

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

        console.log("==>", wordMeaningList.length)

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


server.get('/mistake', async (req, res) => {
    let { word } = req.query;
    word = word.toLowerCase().trim();
    
    const AI_MODEL = "gemini-2.5-flash";

    try {
        if (word.length > maxLengthWord) {
            res.send({
                text: `Max length ${maxLengthWord} characters`
            });
        }

        const INSTRUCTION = `
            Analyze 3 common pronunciation or usage errors specific to Vietnamese native speakers when using this word:  ${word}
            Return a json following format

             "commonVietnameseErrors": [
            {
                "errorDescription": "string",
                "solutionFix": "string"
            }]
            Output requirement:
                Return only one JSON object
                The property value are written in Vietnamese.
        `
        const ai = new GoogleGenAI({ apiKey: process.env.APIKEY_MISTAKE });
        const response = await ai.models.generateContent({
            model: AI_MODEL,
            contents: INSTRUCTION,
            config: {
                temperature: 0.5
            }
        });

        if (response.text) {
            const CLEANUP_REGEX = /^\s*```json\s*|\s*```\s*$/g;
            const jsonString = JSON.parse(response.text.replace(CLEANUP_REGEX, ''));

            res.send({
               commonVietnameseErrors: jsonString.commonVietnameseErrors
            });
        }

    } catch (error) {
        console.error("Fetch error:", error);
        res.status(500).send({ message: error.message });
    }
}
)


server.get('/gemini', async (req, res) => {
    let { word } = req.query;

    // config param logic
    let flagFailCount = 0;
    let maxFailCount = 7;

    // AI param
    const AI_KEY_LIST = process.env.APIKEY.split(' ');
    const AI_KEY_LENGTH = AI_KEY_LIST.length;
    const AI_MODEL = "gemini-2.5-flash";
    const INSTRUCTION = `
        ${word} analyze and maintain the order of syllables: onset, nucleus, coda
        
        Your must follow the rule before get the final result 
        ORDER OF PRIORITY OF SYLLABLE SEPARATION RULES
        1/ The strongest rule - Short vowel constaint
        1.1/ Only applies to: Short vowels /ɒ, æ, ʊ, ɪ, ɛ/ carry primary stress
            Syllable containing short vowel stressed → must be closed (CVC)
        1.2/ How to choose a coda: Select the maximum valid coda (single, double, triple). The consonant remainder (if any) is pushed to the onset of the next syllable, if valid.     
        1.3/ Purpose: Keep short vowels “checked”, avoid prolongation
        1.4/ Example
            /ˈkæ.tə/ → /ˈkæt.ə/ (because /æ/ is stressed → must close)
            /ˈæ.tləs/ → /æt.ləs/ (coda /t/)

        2/ Additional Rule – Stressed Open Vowel Constraint (SOVC)	
        2.1/ Only applies to: Open/long vowels (open vowels /ɑː, ɜː, ɔː/) with main stress
            Syllable containing stressed open vowel → should close syllable
        2.2/ How to choose coda: Choose the maximum valid coda (single, double, triple). Consonant residue pushes to the onset of the next syllable, if valid
        2.3/ Example:
            /ˈfɑː.mə/ → /ˈfɑːm.ə/ (coda /m/ do SOVC)
            /ˈɜː.rɪŋ/ → /ˈɜːr.ɪŋ/ (coda /r/)

        3/ Maximal Onset Principle (MOP) 
        3.1/ Applicable when: Vowel is not short vowel or short vowel but not primary stressed
            Push the consonant to the onset of the next syllable as much as possible, provided the onset is valid in English
        3.2/ Example:
            ˌkæ.təˈstrɒ.fɪk/ → /ˌkæt.əˈstrɒ.fɪk/ (short vowel /æ/ is not stressed → apply MOP to the next consonant)
            /ˌɪn.təˈnæʃ.ə.nəl/ → /ɪn.tə.næʃ.ə.nəl/ (non-stressed consonant → push to onset)

        4/ General notes when dividing
        4.1/ If the coda is already selected but there is a consonant → push to the next syllable onset, if valid
        4.2/ Unstressed syllables → MOP applies normally
        4.3/ /r/ at the end of syllable 2 → depends on American or British accent

        5/ Special notes on /r/
        5.1/ British English (RP, non-rhotic)
        5.1.1/ RP transcription still writes /r/ when written as /kɑː(r)/ to reflect spelling and linking /r/.
        5.1.2/ In the CODA table and O–N–C tree diagram, /r/ is not considered a coda if:
            - It does not follow a vowel in the same syllable (non-rhotic)
            - The syllable ends in an open vowel /ɑː, ɜː, ɔː/
        5.1.3/ Example:
            farmer RP /ˈfɑːmə(r)/ Syllable 1: Onset = /f/, Nucleus = /ɑː/, Coda = /m/; Syllable 2: Onset = Ø, Nucleus = /ə/, /r/ is not a coda

            car RP /kɑː(r)/ Onset = /k/, Nucleus = /ɑː/, Coda = Ø; /r/ appears in transcription but is not a coda

        5.2/ American accent (AmE, rhotic)
        5.2.1/
            /r/ is always pronounced at the end of a syllable, and is considered a coda when it is at the end of a syllable. It not only appears in spelling, but also participates directly in the O–N–C syllable structure.
            Example
                farmer	AmE	/ˈfɑːrmər/	Âm tiết 1: Onset = /f/, Nucleus = /ɑː/, Coda = /rm/; Âm tiết 2: Onset = Ø, Nucleus = /ə/, Coda = r
                car	AmE	/kɑːr/	Onset = /k/, Nucleus = /ɑː/, Coda = /r/
        5.2.2/ 
            RP transcription still records /r/ when written as /kɑː(r)/ to reflect spelling and linking /r/.
            In the CODA table and O–N–C tree diagram, /r/ is not considered a coda if:
                -It does not follow a vowel in the same syllable (non-rhotic)
                -The syllable ends with an open vowel /ɑː, ɜː, ɔː/
            Example
                farmer RP /ˈfɑːmə(r)/ /ˈfɑːm.ə/ → Syllable 1: Onset = /f/, Nucleus = /ɑː/, Coda = /m/; Syllable 2: Onset = Ø, Nucleus = /ə/, /r/ is not a coda
                car RP /kɑː(r)/ Onset = /k/, Nucleus = /ɑː/, Coda = Ø; /r/ appears in the transcription but is not a coda
        6/ Stressed Diphthong Rule (SDR)
        6.1/ Common diphthongs:
        /aɪ, eɪ, ɔɪ, aʊ, oʊ, ɪə, eə, ʊə/
        Diphthong is not required to close the syllable, not subject to SVC or SOVC → MOP predominance.
        Result: The consonant after the diphthong is pushed to onset, unless the onset is invalid.
        6.2/ Example
        /ˈvaɪ.tə.mɪn/
        -/aɪ/ carries stress but does not need a coda
        -/t/ pushes to onset: /ˈvaɪ.tə/
        /ˈseɪ.və/ → /seɪ.və/ (does not need a coda)
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
            console.error(`Fetch error:(${indexKey})`, error);
            flagFailCount++;
            indexKey = ((indexKey + 1) % AI_KEY_LENGTH)
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
