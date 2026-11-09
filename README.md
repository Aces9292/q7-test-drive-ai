# Q7 Test Drive AI

A phone web app that turns Google's Gemini Live into a ride-along voice salesperson for the 2027 Audi Q7 test drive at Audi Fairfield. You run it on an Android phone plugged into the car, and the voice plays through the car speakers via Android Auto.

## How it works

- `index.html`, `app.js`: the app. It connects straight from the phone's browser to the Gemini Live API (model `gemini-3.8-live`) over a WebSocket.
- `guide.txt`: everything the AI knows and how it should sell. It's sent as the AI's instructions at the start of every drive. **To switch to a different car, edit this file.**
- `mic-worklet.js`: turns the phone mic into the 16 kHz audio format Gemini expects.
- No server and no database. The API key is stored only in that phone's browser. Captions are cleared when the drive ends.

## One-time setup

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create an API key in a Google Cloud project that has **billing turned on**. On the free tier, Google may use your drives to improve its products and humans may review them. With billing on, they don't.
2. In Google Cloud Console → APIs & Services → Credentials, restrict the key to the **Generative Language API**. Under Billing → Budgets, set a budget alert of about $20.
3. On the phone, open the app link in Chrome and tap ⋮ → **Add to Home screen**.
4. Open the app, paste the key into Settings, and pick a voice.

## On the drive

1. Plug the phone into the Q7 so Android Auto is running, and turn the car volume up.
2. Keep the app open on the phone screen. It keeps the screen awake. The passenger runs it, never the driver.
3. Tap **Start test drive**. The AI introduces itself.
4. Buttons: **Stop talking** cuts it off, **Mic on/off** mutes it, **Heading back** starts the closing questions, **End drive** stops everything.

## Cost

About $0.005 per minute for audio in and $0.018 per minute for audio out, so a 30-minute drive costs well under $1.

## Before customers use it

PAG IT's directive (Aug 24, 2026) says customer data can't go through personal systems or services. On a personal API key, customer speech goes to Google. Get written sign-off from IT or your manager before using it with customers. Until then, test it on solo drives.
