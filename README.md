# Q7 Training Drive

An AI product instructor that rides along in the 2027 Audi Q7 and teaches Audi Fairfield sales consultants how to demo the car. It works lesson by lesson and stays in sync with where the car is. It runs in Chrome on an Android phone plugged into the car, and the voice plays through the car speakers via Android Auto.

## How it works

- **Lessons tied to the road.** `curriculum.json` holds 19 lessons. Each lesson belongs to a zone: the lot, local roads, stopped, highway, I-95, the Merritt Parkway, or back at the store. Some fit anywhere, and one only runs after dark.
- **The phone knows the zone.** GPS speed plus an OpenStreetMap road lookup tell the app which zone you're in. For example, a motorway tagged I-95 counts as I-95.
- **Lessons start on the right road.** When you reach a road whose lessons are time-sensitive (any highway, I-95, the Merritt, or back at the store), the instructor wraps up its current topic and switches. Getting on I-95 starts adaptive cruise, then hands-free driving, then assisted lane change.
- **The instructor checks in with the phone.** It can call `get_drive_status` (zone, road, speed, dark or not, lessons left) and `complete_lesson`. It can't read the car's screens, so it asks the driver what the display shows before each step.
- **Every lesson has the same parts:** setup, how it works, turning it on now (coaching the driver step by step), the customer demo talk track, watch-outs, and a practice where a consultant demos it and the instructor gives feedback.
- **Steps marked [VERIFY]** come from Audi's other new models (Q9, Q6 and A6 e-tron). The instructor says so and asks the driver to confirm. Correct them in `curriculum.json` after your first drive.

Files:
- `instructor.txt`: the instructor's role, teaching method, safety and compliance rules.
- `curriculum.json`: the lessons. Edit these to change what gets taught where.
- `car-facts.txt`: the window sticker, lineup and competitor facts.
- `app.js`, `index.html`, `mic-worklet.js`: the app itself.

## Using it

1. Open https://aces9292.github.io/q7-test-drive-ai/ in Chrome on the phone, then tap ⋮ → **Add to Home screen**.
2. Paste the Gemini API key into Settings. Allow the microphone and location when Chrome asks.
3. Plug the phone into the Q7 so Android Auto is running, and turn the volume up. The passenger runs the phone.
4. Tap **Start training drive**. Buttons:
   - **Next lesson:** skip ahead.
   - **Repeat:** go over the current lesson again.
   - **Practice:** the instructor plays a customer and gives feedback.
   - **Debrief:** quiz and wrap-up.
   - **Stop talking:** cut the instructor off.
   - **Mic on/off:** mute the phone mic.
   - **End drive:** stop and clear everything.

## Cost and privacy

- **Cost:** a 30-minute drive costs well under $1 on the paid Gemini API.
- **Data:** with billing on, Google doesn't use the conversations for training. The car's rough location goes to Google and to OpenStreetMap for road names. Nothing from the drive is saved on the phone.
- **Content:** everything in the curriculum comes from public Audi press releases and reviews. Don't paste Audi or PAG internal training material into these files. Under PAG IT's Aug 24, 2026 directive, that would need IT sign-off first.
