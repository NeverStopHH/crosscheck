/**
 * THE ROUND-3 HOLD-OUT'S PROMPTS, NOW TRAINING DATA (hold-out review round 3,
 * decision 12). Copied verbatim from the reviewer's review-hints3/
 * holdout-rows.ts; only this paragraph is new. The reviewer's own header
 * follows, unchanged, and so do the labels: training rows are not relabelled.
 * SYNTHETIC TEXT ONLY.
 *
 * FRESH HOLD-OUT ROWS (review-hints3), written 2026-10-06T15:30Z BEFORE
 * opening review-hints2/, schema/test/fixtures/holdout-corpus.ts,
 * schema/test/fixtures/prompt-corpus.ts or prompt-corpus-gate.test.ts rows.
 * Labels follow the owner rules, not the code: "cf" = content-free (no task
 * topic: continue/ok/limit chatter, interrupts, answer-shaping, option
 * picking, bare agent commands with no object, bare slash commands, harness
 * turns, questions about the agent's own last answer); "task" = a real task,
 * however short. `tree` = the teammate tree a task SHOULD reach (null = no
 * tree matches; "tradeoff" = only one task word, DESIGN's accepted miss).
 */
export interface Row {
  readonly id: string;
  readonly label: "cf" | "task";
  readonly lang: "de" | "en" | "mix" | "ch" | "at";
  readonly cat: string;
  readonly prompt: string;
  readonly tree?: string | null;
  readonly why: string;
}

const cf = (id: string, lang: Row["lang"], cat: string, prompt: string, why: string): Row => ({ id, label: "cf", lang, cat, prompt, why });
const task = (id: string, lang: Row["lang"], cat: string, prompt: string, tree: string | null, why: string): Row => ({
  id, label: "task", lang, cat, prompt, tree, why,
});

const LONG_DE_META =
  "Okay, also kurz zur Lage: Ich war gerade eine Weile weg, weil das Limit wieder voll war, und ich musste ungefähr zwei Stunden warten, bis es zurückgesetzt wurde. " +
  "Jetzt ist es wieder da, zumindest zeigt mir die Anzeige das so an, und ich hoffe, dass es diesmal ein bisschen länger hält als beim letzten Mal. " +
  "Ich weiß ehrlich gesagt nicht mehr genau, wo wir stehengeblieben sind, aber du hast ja den Verlauf, also schau einfach selbst nach, was als Nächstes dran war. " +
  "Bitte fang nicht wieder ganz von vorne an, das hat beim letzten Mal unnötig viel Zeit gekostet und ich will nicht, dass wir das Kontingent wieder in einer Stunde aufbrauchen. " +
  "Wenn du merkst, dass der Kontext zu voll wird, dann sag mir lieber vorher Bescheid, dann mache ich ein compact oder starte eine neue Sitzung, das ist mir lieber als wenn du mittendrin abbrichst. " +
  "Ansonsten gilt alles, was wir vorhin besprochen haben, ich habe meine Meinung dazu nicht geändert. " +
  "Ich bin heute Abend noch ungefähr zwei Stunden am Rechner, danach muss ich los, also wäre es gut, wenn wir bis dahin einen Stand haben, den ich mir morgen früh in Ruhe anschauen kann. " +
  "Falls du zwischendurch Fragen hast, stell sie ruhig, aber bitte gesammelt und nicht alle fünf Minuten einzeln, sonst komme ich zu nichts anderem. " +
  "Und wenn irgendwas schiefgeht, versuch es nicht zehnmal hintereinander, sondern halt kurz an und erklär mir, was los ist. " +
  "Das war es eigentlich schon, ich wollte nur sicherstellen, dass wir auf demselben Stand sind, bevor du weitermachst. " +
  "Ach so, und noch etwas: Wenn du am Ende eine Zusammenfassung schreibst, dann bitte kurz und knapp, nicht drei Seiten, ich lese das wahrscheinlich erst morgen beim ersten Kaffee und will dann nicht ewig scrollen müssen. " +
  "Also: weiter wie geplant, in deinem Tempo, und denk an das Limit. Danke dir schon mal, und bis gleich.";

const LONG_EN_META =
  "Alright, quick status from my side before you pick things back up. I ran into the usage limit about an hour ago, so I stepped away, grabbed some coffee and waited for the window to reset. " +
  "It looks like it's back now, the counter shows plenty of headroom again, so we should be fine for a while. " +
  "I honestly don't remember the exact point where you stopped, but you have the whole conversation in front of you, so just look at what you were doing last and carry on from there. " +
  "Please don't start over from scratch, that burned a lot of time yesterday and I would rather not waste the fresh quota on repeating things we already settled. " +
  "If you notice that the context is getting close to full, tell me first and I'll compact or open a new session myself, which I prefer to you getting cut off halfway through something. " +
  "Everything we agreed earlier still stands, I haven't changed my mind about any of it. " +
  "I have roughly two more hours today, after that I need to leave, so it would be nice to reach a state I can look at calmly tomorrow morning. " +
  "If you have questions along the way, feel free to ask, but please batch them instead of pinging me every few minutes, otherwise I won't get anything else done. " +
  "And if something goes wrong, don't retry ten times in a row, just pause and tell me what happened. " +
  "That's really all, I just wanted to make sure we are on the same page before you continue. " +
  "Oh, and one more thing: when you write the wrap-up at the end, keep it brief, a few lines at most, because I will probably read it tomorrow over breakfast and I really don't want to scroll through pages of it. " +
  "So: keep going as planned, at your own pace, and keep an eye on the limit this time. Thanks a lot, talk soon.";

const LONG_MIX_META =
  "So, kurzes Update: das weekly limit war heute Mittag komplett durch, ich hab dann eine neue session aufgemacht und gewartet bis der reset durch ist. " +
  "Now it's back, the usage bar is green again, also können wir weitermachen. Ich weiß nicht mehr genau where we left off, aber du hast ja den ganzen Verlauf. " +
  "Please don't redo the steps you already finished, das kostet nur tokens und am Ende sind wir wieder am Limit bevor irgendwas fertig ist. " +
  "If the context window gets too full, sag Bescheid, dann mach ich compact, das ist besser als ein harter Abbruch mitten drin. " +
  "Alles was wir heute Morgen abgesprochen haben gilt weiterhin, nothing changed on my side, und ich will auch nicht nochmal alles neu diskutieren. " +
  "I'm around for another hour or so, dann bin ich weg bis morgen früh, also wäre es nice wenn bis dahin ein Stand da ist den ich in Ruhe lesen kann. " +
  "Fragen gerne, aber bitte gesammelt, not one every two minutes, sonst komm ich zu nix. " +
  "Und falls was hängt: nicht zehnmal retry, einfach kurz stoppen und mir sagen was los ist, dann schauen wir zusammen. " +
  "Ich hab übrigens auch gemerkt dass die Antworten vorhin ziemlich lang waren, keep it a bit shorter please, ich lese das gerade am Handy. " +
  "Das wars eigentlich, wollte nur sicher sein dass wir on the same page sind bevor du weitermachst. " +
  "Oh und noch was, falls du am Ende eine summary schreibst: bitte kurz, ein paar Zeilen reichen völlig, ich les das eh erst morgen früh beim Kaffee. " +
  "And if you're unsure about anything, lieber einmal kurz fragen als drei Stunden in die falsche Richtung laufen, das hatten wir letzte Woche schon mal und das war nicht so geil. " +
  "Also: weiter wie geplant, in your own pace, und behalt das Limit im Auge. Danke!";

const LONG_DICTATED_DE =
  "ja also ähm ich bin wieder da das limit war voll und ist jetzt wieder zurückgesetzt ähm ich hab ehrlich gesagt keine ahnung mehr wo wir genau waren " +
  "aber du weißt das ja besser als ich also mach einfach da weiter wo du aufgehört hast ähm bitte nicht alles nochmal von vorne machen das hat letztes mal ewig gedauert " +
  "und dann war das kontingent wieder weg bevor irgendwas fertig war ähm wenn der kontext zu voll wird sag kurz bescheid dann mach ich compact oder ne neue session auf " +
  "ähm ansonsten gilt alles was wir vorhin besprochen haben ich hab da meine meinung nicht geändert und ich will das auch nicht nochmal alles durchkauen " +
  "ich hab heute noch so zwei stunden zeit dann muss ich weg also wär super wenn wir bis dahin irgendwie einen stand haben den ich mir morgen in ruhe anschauen kann " +
  "ähm fragen gerne aber bitte gesammelt und nicht alle fünf minuten eine einzelne sonst komm ich zu gar nix anderem mehr " +
  "ähm und wenn was schiefgeht bitte nicht zehnmal hintereinander neu versuchen sondern kurz stoppen und mir sagen was los ist dann schauen wir das zusammen an " +
  "ähm ja und die antworten vorhin waren ein bisschen lang also gerne etwas kürzer ich lese das gerade nebenbei am handy " +
  "ähm ja das wars eigentlich ich wollte nur sicher sein dass wir auf dem gleichen stand sind bevor du weitermachst " +
  "ähm und wenn du am ende so ne zusammenfassung schreibst dann bitte kurz nicht drei seiten ich les das eh erst morgen früh beim kaffee " +
  "ähm und falls du dir bei irgendwas unsicher bist lieber einmal kurz fragen als stundenlang in die falsche richtung das hatten wir ja letzte woche schon " +
  "also weiter wie geplant in deinem tempo und behalt das limit im auge ähm danke dir schon mal und bis später ne";

const LONG_EN_SESSION_META =
  "ok so here's the deal with this session. it's been a long one and I know we've been going back and forth a lot, and I can see the context counter creeping up, so before anything else let me lay out how I want to handle the rest of the evening. " +
  "first, the limit: it reset around twenty minutes ago, so we have a full window again, but last time it ran out right in the middle of something and I lost track of what was going on, which was annoying. " +
  "so this time, please give me a short heads-up when you think we're getting close, like a one-line note, nothing fancy. " +
  "second, if the session gets too long I'd rather start a fresh one than let it compact on its own, because the automatic compaction sometimes drops things I care about. " +
  "just tell me and I'll do it by hand. third, please don't go back over the things we already finished, I trust that they're done, and repeating them only eats tokens. " +
  "fourth, I'll be half watching from another screen, so keep your messages short and only stop to ask me when you really can't decide on your own. " +
  "if you hit an error, try once, maybe twice, and if it still fails just stop and summarize instead of looping. " +
  "and finally, when you're done with the current step, don't wait for me to say go, just continue to the next one on the list we made. " +
  "oh, and when you write a recap at the end keep it to a few lines, I'll read it tomorrow morning over coffee. " +
  "that's all from me. no new instructions beyond that, everything else stays as it was. thanks, and sorry for the wall of text, I just wanted it written down once so I don't have to repeat myself after every reset.";

const LONG_TASK_EN_REDIS =
  "Hey, so I was out most of the morning and only now got back to the laptop, the usage limit also reset in the meantime which is nice. " +
  "Anyway, I talked to Mike over lunch and he mentioned something that has been bugging the analysts for a few days: " +
  "the redis cache eviction keeps dropping scouting feed entries, so people open the feed and half of yesterday's notes are just gone. " +
  "He wasn't sure whether it's the TTL or the memory policy, but it happens more often after deploys. Could you look into that when you get a chance? " +
  "No rush on anything else we discussed, that can wait until tomorrow, and please keep your answers short today, I'm reading on my phone.";

const LONG_TASK_DE_OOM =
  "Moin, kurzer Kontext bevor du loslegst: Ich hatte heute Vormittag ewig Meetings und bin erst jetzt wieder am Rechner, das Kontingent ist auch wieder voll. " +
  "Gestern Abend hat mir Mike noch geschrieben, und zwar läuft der Import-Worker bei Backpressure in einen OOM, sobald die Tracking-Queue über 50 Spiele wächst. " +
  "Er meinte, das sei seit dem letzten Release so, aber sicher ist er sich nicht. Schau dir das bitte als Erstes an, alles andere hat Zeit bis morgen. " +
  "Und bitte halte die Antworten heute kurz, ich bin nebenbei noch in einem Call.";

const LONG_TASK_MIX_EPL =
  "Hi, kurz: limit ist wieder da, session ist frisch, alles gut. Ich hab gerade mit Tobi gesprochen, he says that Extract All for the EPL still throws an HTTP 500 on staging, " +
  "und er vermutet dass die EPL competition id in der staging env einfach nicht gesetzt ist. Kannst du das checken? " +
  "Rest von heute Morgen bleibt wie besprochen, no changes there, und bitte keine langen Erklärungen.";

const LONG_TASK_DICTATED_HEATMAP =
  "ja also ähm ich hab gerade mit ken telefoniert und der meinte dass ähm die heatmap homography bei den weitwinkel kameras verschoben ist " +
  "also die punkte driften bei den eckfahnen so drei vier meter weg ähm kannst du dir das mal anschauen ähm der rest kann warten danke";

const LONG_TASK_EN_WHATSAPP =
  "ok limit reset, new session, I'm back. before you continue with the list from earlier: Sara pinged me that the whatsapp bot status line duplicates " +
  "whenever a deferred answer comes in, customers see it twice. can you take a look at that first? after that just continue as planned, keep it short.";

const LONG_TASK_EN_LATE =
  "Some background first, since you were not in the meeting this morning: we went through the roadmap for next quarter, talked about hiring, budgets, " +
  "the offsite in Lisbon, the new office chairs, the coffee machine situation, holiday planning, who covers support in December, the onboarding buddy rotation, " +
  "the reading group, the conference talk proposals, the design review cadence, and the retro format. None of that matters for you right now. " +
  "What I actually need: the pass options toggle is not persisted between sessions, it resets to off whenever the workbench is reopened. Please fix that.";

const LONG_TASK_EN_PAST_SLICE =
  "Context dump, sorry, this is long. " +
  "I spent the whole afternoon in planning and only now have a minute, so let me first write down everything that is on my mind before I forget it, " +
  "even though most of it is not for you: the quarterly planning deck still needs the hiring slide, the budget spreadsheet has to go to finance by Friday, " +
  "the offsite agenda is not final, the coffee order needs confirming, the holiday calendar has gaps in December, the onboarding checklist needs an owner, " +
  "the reading group picked a new book, the conference proposals are due next week, the design review moved to Thursdays, the retro format changes, " +
  "the support rota for the holidays is unclear, the new laptops arrive Monday, the office plants need watering, the parking permits expire, " +
  "the newsletter needs a paragraph, the team photo is rescheduled, the birthday card for Sara is in the kitchen, the whiteboard markers are empty, " +
  "the printer is broken again, the window in the meeting room does not close, the heating is too loud, the badge reader beeps twice, " +
  "the fridge needs cleaning, the umbrella stand is full, the bike rack is blocked, the plant on my desk died, the calendar invites are double, " +
  "the shared drive is a mess, the wiki needs pruning, the old project folders should be archived, the Slack channels need renaming, " +
  "the mailing list has spam, the guest wifi password changed, the visitor log is outdated, the fire drill is next week, the first aid kit is half empty, " +
  "the keys for the storage room are missing, the projector remote has no batteries, the standing desks squeak, the blinds are stuck, " +
  "the lunch order form is gone, the recycling schedule changed, the delivery entrance is locked, the elevator is slow, the stairwell light flickers, " +
  "the coat hooks fell off the wall, the doormat is soaked, the clock in the hallway is an hour behind, the plant food ran out, the kettle descaler is missing, the spare chairs are in the wrong room, the poster in the lobby is crooked. " +
  "Okay, none of that is for you, really. The one thing for you: the daily quota reset cron runs twice, at midnight UTC and again at midnight local time. Please fix it.";

export const ROWS: readonly Row[] = [
  // ── content-free: German short continuation ──
  cf("cf001", "de", "continue", "mach weiter", "bare continuation"),
  cf("cf002", "de", "continue", "ja mach weiter", "assent + continuation"),
  cf("cf003", "de", "continue", "weiter bitte", "continuation + please"),
  cf("cf004", "de", "continue", "jo weiter", "colloquial assent + continue"),
  cf("cf005", "de", "continue", "passt, weiter", "assent + continue"),
  cf("cf006", "de", "continue", "okay dann mach mal", "go-ahead"),
  cf("cf007", "de", "continue", "ja genau so", "assent"),
  cf("cf008", "de", "continue", "ja klingt gut, mach", "assent + go"),
  cf("cf009", "de", "continue", "alles klar, leg los", "go-ahead"),
  cf("cf010", "de", "continue", "gut, dann weiter im text", "idiom 'weiter im Text' = carry on"),
  cf("cf011", "de", "continue", "na dann mal los", "go-ahead"),
  cf("cf012", "de", "continue", "jetzt weiter", "continuation"),
  cf("cf013", "de", "continue", "und weiter gehts", "continuation"),
  cf("cf014", "de", "continue", "joa passt so", "assent"),
  cf("cf015", "en", "continue", "ok", "assent"),
  cf("cf016", "en", "continue", "k", "assent, one letter"),
  cf("cf017", "de", "continue", "jup", "assent"),
  cf("cf018", "de", "continue", "danke dir, weiter", "thanks + continue"),
  cf("cf019", "de", "continue", "super danke", "thanks"),
  cf("cf020", "de", "continue", "perfekt, genau so machen", "assent"),
  // ── content-free: English short continuation ──
  cf("cf021", "en", "continue", "go on", "continuation"),
  cf("cf022", "en", "continue", "keep going", "continuation"),
  cf("cf023", "en", "continue", "continue please", "continuation"),
  cf("cf024", "en", "continue", "yes do it", "assent + go"),
  cf("cf025", "en", "continue", "sounds good, proceed", "assent + continue"),
  cf("cf026", "en", "continue", "ok go", "go-ahead"),
  cf("cf027", "en", "continue", "yep, carry on", "continuation"),
  cf("cf028", "en", "continue", "sure thing", "assent"),
  cf("cf029", "en", "continue", "do it", "go-ahead"),
  cf("cf030", "en", "continue", "go for it", "go-ahead"),
  cf("cf031", "en", "continue", "alright then", "assent"),
  cf("cf032", "en", "continue", "next", "sequencing"),
  cf("cf033", "en", "continue", "lets go", "go-ahead"),
  cf("cf034", "en", "continue", "yes please continue where you left off", "continuation"),
  cf("cf035", "en", "continue", "great, keep at it", "continuation"),
  // ── content-free: typos ──
  cf("cf036", "de", "typo", "mahc weiter", "swapped letters in mach"),
  cf("cf037", "de", "typo", "mcah weiter bitte", "swapped letters"),
  cf("cf038", "de", "typo", "weiterr", "doubled letter"),
  cf("cf039", "en", "typo", "contniue", "swapped letters in continue"),
  cf("cf040", "en", "typo", "kepe going", "swapped letters in keep"),
  cf("cf041", "en", "typo", "pls conitnue", "swapped letters"),
  cf("cf042", "de", "typo", "ja mach weietr", "swapped letters in weiter"),
  cf("cf043", "en", "typo", "go ahaed", "swapped letters in ahead"),
  cf("cf044", "de", "typo", "jaa passt", "doubled letter in ja"),
  cf("cf045", "de", "typo", "okk weiter", "doubled letter in ok"),
  // ── content-free: limit / session chatter ──
  cf("cf046", "de", "limit", "limit ist wieder da, mach weiter", "limit report + continue"),
  cf("cf047", "en", "limit", "usage limit reset, continue", "limit report + continue"),
  cf("cf048", "de", "limit", "das Limit ist zurückgesetzt, bitte weitermachen", "limit report + continue"),
  cf("cf049", "de", "limit", "limit war voll, jetzt gehts wieder, weiter", "limit report + continue"),
  cf("cf050", "de", "limit", "Kontingent ist wieder frei, mach da weiter wo du aufgehört hast", "quota report + continue"),
  cf("cf051", "en", "limit", "session limit hit earlier, it's back now, continue", "limit report + continue"),
  cf("cf052", "en", "limit", "rate limit is gone, retry", "limit report + retry"),
  cf("cf053", "en", "limit", "ok the 5 hour limit reset, keep going", "limit report + continue"),
  cf("cf054", "en", "limit", "weekly limit reset, pick up where you stopped", "limit report + resume"),
  cf("cf055", "de", "limit", "token limit war erreicht, jetzt weiter", "limit report + continue"),
  cf("cf056", "de", "limit", "context ist voll gewesen, mach weiter nach dem compact", "context report + continue"),
  cf("cf057", "de", "limit", "nach dem neustart bitte weiter", "restart report + continue"),
  cf("cf058", "en", "limit", "restarted the session, continue", "restart report + continue"),
  cf("cf059", "de", "limit", "limit zurückgesetzt um 14 uhr, weiter gehts", "limit report with clock time"),
  cf("cf060", "de", "limit", "sorry war limit, weiter", "apology + limit + continue"),
  cf("cf061", "de", "limit", "usage reset vor ner minute, fahr fort", "limit report + continue"),
  cf("cf062", "de", "limit", "limt ist zurükgesetzt, mach weitre", "typos in limit chatter"),
  cf("cf063", "en", "limit", "you hit the limit before, it reset an hour ago, please resume", "limit report + resume"),
  cf("cf064", "de", "limit", "ich hatte kein Kontingent mehr, jetzt wieder, bitte nochmal von vorne", "quota report + restart from the top"),
  cf("cf065", "de", "limit", "die session ist abgelaufen, mach einfach weiter", "session expiry + continue"),
  // ── content-free: Swiss / Austrian ──
  cf("cf066", "ch", "dialect", "isch guet, mach wiiter", "Swiss: is fine, carry on"),
  cf("cf067", "at", "dialect", "jo passt scho, weida", "Austrian assent + continue"),
  cf("cf068", "at", "dialect", "gemma weiter", "Austrian: let's go on"),
  cf("cf069", "at", "dialect", "passt eh, mach weiter", "Austrian assent + continue"),
  cf("cf070", "ch", "dialect", "merci vielmal, chasch wiitermache", "Swiss thanks + you can continue"),
  cf("cf071", "ch", "dialect", "hoi, mach bitte witer", "Swiss greeting + continue"),
  cf("cf072", "at", "dialect", "leiwand, weiter so", "Austrian: great, keep on"),
  cf("cf073", "at", "dialect", "jo eh, mach", "Austrian assent"),
  cf("cf074", "ch", "dialect", "gopfried, limit scho wieder, jetzt wiiter", "Swiss curse + limit + continue"),
  cf("cf075", "at", "dialect", "servus, weiter gehts", "greeting + continue"),
  cf("cf076", "ch", "dialect", "grüezi, bitte wiitermache", "Swiss greeting + continue"),
  cf("cf077", "at", "dialect", "passt scho, schau ma mal", "Austrian: fine, we'll see"),
  cf("cf078", "ch", "dialect", "ja moll, mach", "Swiss assent"),
  cf("cf079", "at", "dialect", "oida weiter", "Austrian filler + continue"),
  cf("cf080", "at", "dialect", "heast, des limit is weg, weida", "Austrian: limit gone, continue"),
  // ── content-free: voice dictation ──
  cf("cf081", "de", "dictation", "ähm ja mach weiter ne", "dictated continuation with fillers"),
  cf("cf082", "de", "dictation", "okay Komma mach weiter Punkt", "dictated punctuation words"),
  cf("cf083", "de", "dictation", "ja also ähm ich würde sagen mach einfach weiter so wie du das geplant hast Punkt", "dictated go-ahead"),
  cf("cf084", "de", "dictation", "äh ja genau Komma das passt so Komma weiter", "dictated assent"),
  cf("cf085", "en", "dictation", "okay so um the limit is back now so just uh continue with what you were doing period", "dictated limit chatter"),
  cf("cf086", "de", "dictation", "ja ähm Punkt weiter Punkt", "dictated continuation"),
  cf("cf087", "de", "dictation", "mach mal weiter und sag Bescheid wenn du fertig bist", "continue + report back"),
  cf("cf088", "de", "dictation", "hm ja okay ähm weiter", "fillers + continue"),
  cf("cf089", "de", "dictation", "ja nee passt schon mach weiter", "assent + continue"),
  cf("cf090", "de", "dictation", "also ich hab jetzt wieder Kontingent ähm mach bitte weiter mit dem was du vorher gemacht hast", "quota + continue previous work"),
  cf("cf091", "de", "dictation", "ja also Komma nochmal Punkt", "dictated 'again'"),
  cf("cf092", "de", "dictation", "äh weiter Fragezeichen", "dictated question mark"),
  cf("cf093", "de", "dictation", "okay neue Zeile mach weiter", "dictated newline"),
  cf("cf094", "de", "dictation", "jaja weiter weiter", "repetition"),
  cf("cf095", "en", "dictation", "ok ok ok go", "repetition"),
  // ── content-free: interrupts ──
  cf("cf096", "en", "interrupt", "stop", "interrupt"),
  cf("cf097", "de", "interrupt", "warte", "interrupt"),
  cf("cf098", "en", "interrupt", "wait wait", "interrupt"),
  cf("cf099", "de", "interrupt", "halt stopp", "interrupt"),
  cf("cf100", "de", "interrupt", "moment mal", "interrupt"),
  cf("cf101", "en", "interrupt", "hold on a sec", "interrupt"),
  cf("cf102", "de", "interrupt", "nein, nicht so", "rejection of approach, no topic"),
  cf("cf103", "en", "interrupt", "no not like that", "rejection, no topic"),
  cf("cf104", "de", "interrupt", "abbrechen", "cancel"),
  cf("cf105", "en", "interrupt", "cancel that", "cancel"),
  cf("cf106", "de", "interrupt", "stop, warte kurz", "interrupt"),
  cf("cf107", "de", "interrupt", "hör auf", "interrupt"),
  cf("cf108", "de", "interrupt", "nicht weitermachen", "interrupt"),
  cf("cf109", "en", "interrupt", "pause", "interrupt"),
  cf("cf110", "en", "interrupt", "undo that", "undo, no object"),
  // ── content-free: answer shaping / option picking ──
  cf("cf111", "de", "shaping", "kürzer bitte", "answer shaping"),
  cf("cf112", "en", "shaping", "shorter", "answer shaping"),
  cf("cf113", "en", "shaping", "more detail please", "answer shaping"),
  cf("cf114", "de", "shaping", "erklär nochmal einfacher", "answer shaping"),
  cf("cf115", "de", "shaping", "auf deutsch bitte", "language switch"),
  cf("cf116", "en", "shaping", "in english please", "language switch"),
  cf("cf117", "en", "option", "option 2", "option pick"),
  cf("cf118", "de", "option", "nimm variante B", "option pick"),
  cf("cf119", "de", "option", "die erste", "option pick"),
  cf("cf120", "en", "option", "the second one", "option pick"),
  cf("cf121", "de", "option", "beides", "option pick"),
  cf("cf122", "de", "option", "mach option a", "option pick"),
  cf("cf123", "en", "option", "go with your recommendation", "option pick by deferral"),
  cf("cf124", "de", "option", "du entscheidest", "deferral"),
  cf("cf125", "en", "option", "whatever you think is best", "deferral"),
  cf("cf126", "de", "shaping", "nochmal aber ausführlicher", "answer shaping"),
  cf("cf127", "de", "shaping", "fass das zusammen", "summarize the answer"),
  cf("cf128", "en", "shaping", "as a table please", "format shaping"),
  cf("cf129", "de", "shaping", "als liste", "format shaping"),
  cf("cf130", "en", "shaping", "think harder", "answer shaping"),
  // ── content-free: questions about the agent's own last answer ──
  cf("cf131", "de", "own-answer", "warum hast du das so gemacht?", "question about its own last step"),
  cf("cf132", "de", "own-answer", "wieso?", "bare why"),
  cf("cf133", "en", "own-answer", "why did you do that?", "question about its own last step"),
  cf("cf134", "de", "own-answer", "bist du sicher?", "confidence check"),
  cf("cf135", "en", "own-answer", "are you sure?", "confidence check"),
  cf("cf136", "de", "own-answer", "was meinst du damit?", "clarification of own answer"),
  cf("cf137", "en", "own-answer", "what do you mean?", "clarification"),
  cf("cf138", "de", "own-answer", "kannst du das nochmal erklären?", "re-explain"),
  cf("cf139", "de", "own-answer", "warum nicht anders?", "why not otherwise"),
  cf("cf140", "de", "own-answer", "hast du das getestet?", "did you test it, no object"),
  // ── content-free: bare agent commands ──
  cf("cf141", "en", "operation", "commit", "bare operation"),
  cf("cf142", "en", "operation", "commit and push", "bare operations"),
  cf("cf143", "en", "operation", "push it", "bare operation"),
  cf("cf144", "de", "operation", "mach nen PR", "open a PR, no object"),
  cf("cf145", "en", "operation", "run the tests", "bare operation"),
  cf("cf146", "de", "operation", "tests laufen lassen", "bare operation"),
  cf("cf147", "en", "operation", "lint", "bare operation"),
  cf("cf148", "en", "operation", "merge it", "bare operation"),
  cf("cf149", "en", "operation", "deploy", "bare operation"),
  cf("cf150", "en", "operation", "build", "bare operation"),
  cf("cf151", "de", "operation", "zeig mir den diff", "show diff"),
  cf("cf152", "en", "operation", "git status", "bare operation"),
  cf("cf153", "en", "operation", "review", "bare operation"),
  cf("cf154", "en", "operation", "rebase on main", "bare operation"),
  cf("cf155", "de", "operation", "committe und pushe bitte", "bare operations, German verb forms"),
  // ── content-free: slash commands ──
  cf("cf156", "en", "slash", "/compact", "bare slash command"),
  cf("cf157", "en", "slash", "/clear", "bare slash command"),
  cf("cf158", "en", "slash", "/review", "bare slash command"),
  cf("cf159", "en", "slash", "/model", "bare slash command"),
  cf("cf160", "en", "slash", "/cost", "bare slash command"),
  cf("cf161", "en", "slash", "/everything-claude-code:plan", "namespaced slash command"),
  cf("cf162", "en", "slash", "/loop 10m /babysit-prs", "loop of a command"),
  cf("cf163", "en", "slash", "/resume", "bare slash command"),
  // ── content-free: harness turns ──
  cf("cf164", "en", "harness", "<task-notification><task-id>abc123</task-id><summary>Background command \"bun test\" completed (exit code 0)</summary></task-notification>", "task notification"),
  cf("cf165", "en", "harness", "[SYSTEM NOTIFICATION - NOT USER INPUT]\nBackground task finished: rate limit monitor", "system notification head"),
  cf("cf166", "en", "harness", "<system-reminder>The user's usage limit has reset.</system-reminder>", "system reminder"),
  cf("cf167", "en", "harness", "<agent-message from=\"x1\">Session token refresh tests pass</agent-message>", "agent message"),
  cf("cf168", "en", "harness", "<cross-session-message from=\"ken\">CI green on main</cross-session-message>", "cross-session message"),
  cf("cf169", "en", "harness", "<task-notification>\n<summary>Monitor: PR #81 checks failed (session timeout test)</summary>\n</task-notification>", "task notification with topical words"),
  cf("cf170", "en", "harness", "# Autonomous loop tick\nCheck PR status and continue.", "loop tick head"),
  // ── content-free: long rambling meta ──
  cf("cf171", "de", "long-meta", LONG_DE_META, "300+ words of meta about limit, context, schedule; no task"),
  cf("cf172", "en", "long-meta", LONG_EN_META, "300+ words of meta; no task"),
  cf("cf173", "mix", "long-meta", LONG_MIX_META, "mixed-language meta; no task"),
  cf("cf174", "de", "long-meta", LONG_DICTATED_DE, "dictated, unpunctuated meta; no task"),
  cf("cf175", "en", "long-meta", LONG_EN_SESSION_META, "session-handling instructions; no task"),
  // ── content-free: openers ──
  cf("cf176", "mix", "opener", "ok cool, thanks, das war hilfreich, weiter", "thanks + continue"),
  cf("cf177", "mix", "opener", "nice, hat geklappt, next step", "it worked + next"),
  cf("cf178", "en", "opener", "great that worked, now the next one", "it worked + next"),
  cf("cf179", "de", "opener", "jo das läuft jetzt, mach den nächsten schritt", "it works + next step"),
  cf("cf180", "de", "opener", "perfekt, alles grün, weiter mit dem plan", "all green + continue plan"),
  // ── content-free: SUPPLEMENT, written 2026-10-06T15:50Z after dedupe (31 CF exact dups
  //    dropped); only the dup list was seen, never the training rows themselves ──
  cf("cf181", "de", "opener", "weiter so, top", "praise + continue"),
  cf("cf182", "de", "continue", "ok passt, dann machen wir das so", "assent"),
  cf("cf183", "at", "dialect", "jo, des passt, mach ma weiter", "Austrian assent + continue"),
  cf("cf184", "en", "continue", "yeah that looks right, carry on with the rest", "assent + continue"),
  cf("cf185", "de", "limit", "mach weiter, das limit ist wieder voll da und die session läuft noch", "limit report + continue"),
  cf("cf186", "de", "dictation", "ähm okay Komma limit ist durch Komma ich mach gleich weiter Punkt", "dictated limit chatter"),

  // ── task: short, matching a tree ──
  task("t001", "mix", "short", "StatsBomb 429 rate limit beim bulk extract", "wc_sb_rate", "names the StatsBomb 429 bug"),
  task("t002", "en", "short", "why do we get 429 from statsbomb during extraction", "wc_sb_rate", "StatsBomb 429"),
  task("t003", "en", "meta-collision", "session timeout logs users out after 15 minutes", "wc_session_timeout", "session timeout bug"),
  task("t004", "en", "meta-collision", "token refresh fails after key rotation", "wc_jwt_refresh", "token refresh bug"),
  task("t005", "en", "meta-collision", "usage dashboard monthly totals are wrong", "wc_usage_dashboard", "usage dashboard bug"),
  task("t006", "en", "meta-is-task", "the usage limit banner shows wrong numbers", "wc_limit_banner", "META words ARE the task"),
  task("t007", "en", "short", "CI functional tests timing out again", "wc_ci_timeout", "CI timeout"),
  task("t008", "de", "short", "CI rot, functional suite timeout", "wc_ci_timeout", "CI red"),
  task("t009", "en", "meta-collision", "fix the retry storm in the import worker after restart", "wc_retry_storm", "retry storm"),
  task("t010", "de", "short", "warum crasht die cube pipeline bei geplanten spielen ohne events", "wc_cube_future", "cube crash"),
  task("t011", "de", "short", "video upload über 100 MB schlägt mit 413 fehl", "wc_video_upload", "video upload 413"),
  task("t012", "en", "short", "leaderboard first load is slow again", "wc_leaderboard_load", "leaderboard perf"),
  task("t013", "en", "short", "pass options toggle doesn't persist", "wc_pass_options", "pass options"),
  task("t014", "en", "short", "heatmap homography misaligned on wide angle", "wc_heatmap", "heatmap"),
  task("t015", "en", "short", "prismic preview broken on the website", "wc_prismic", "prismic"),
  task("t016", "en", "short", "import worker OOM under backpressure", "wc_import_oom", "OOM"),
  task("t017", "de", "short", "EPL competition id fehlt in staging", "wc_epl_id", "EPL id"),
  task("t018", "en", "short", "metric glossary in the leaderboard UI", "wc_glossary", "glossary"),
  task("t019", "en", "short", "whatsapp bot status line shows twice", "wc_whatsapp", "whatsapp"),
  task("t020", "en", "short", "redis cache eviction drops scouting feed entries", "wc_redis", "redis"),
  task("t021", "en", "meta-collision", "render env change needs restart after terraform apply", "wc_render_env", "restart is the task"),
  task("t022", "en", "meta-collision", "add rate limiting to the public API", "wc_rate_mw", "rate limiting feature"),
  task("t023", "en", "meta-is-task", "token usage accounting for the agent bot is off", "wc_token_usage", "token usage is the task"),
  task("t024", "en", "meta-is-task", "the claude session resume after a usage limit reset loses the context", "wc_session_resume", "the machinery is the bug"),
  task("t025", "en", "meta-is-task", "daily quota reset cron runs twice", "wc_quota_cron", "quota reset is the task"),
  task("t026", "en", "meta-is-task", "weekly report email shows yesterday's numbers", "wc_weekly_report", "weekly report"),
  task("t027", "en", "operation-object", "commit hook blocks push on large files", "wc_commit_hook", "operation words with object"),
  task("t028", "en", "operation-object", "PR merge review checklist is outdated", "wc_review_checklist", "operation words with object"),
  task("t029", "en", "operation-object", "test runner reruns failed tests forever", "wc_test_runner", "operation words with object"),
  task("t030", "en", "operation-object", "build cache invalidation on main is broken", "wc_build_cache", "operation words with object"),
  task("t031", "en", "short", "increase the PGlite pool size to fix the timeouts?", "wc_pglite_pool", "rejected approach tree"),
  // ── task: META collisions ──
  task("t032", "en", "meta-collision", "rate limit bug in the StatsBomb client", "wc_sb_rate", "real rate limit bug"),
  task("t033", "en", "meta-collision", "session timeout too short in the workbench", "wc_session_timeout", "session timeout"),
  task("t034", "en", "meta-collision", "refresh token rotation breaks JWT validation", "wc_jwt_refresh", "token refresh"),
  task("t035", "en", "meta-collision", "usage dashboard totals per organization", "wc_usage_dashboard", "usage dashboard"),
  task("t036", "en", "meta-is-task", "limit banner shows remaining quota wrong", "wc_limit_banner", "limit banner"),
  task("t037", "en", "meta-collision", "context window overflow in deferred composition", "wc_context_overflow", "context window bug"),
  task("t038", "en", "meta-collision", "deferred composition exceeds the context tokens", "wc_context_overflow", "context tokens bug"),
  task("t039", "en", "meta-collision", "retry backoff ignores Retry-After header", "wc_sb_rate", "retry bug"),
  task("t040", "en", "meta-is-task", "quota reset job runs at midnight twice", "wc_quota_cron", "quota reset job"),
  task("t041", "de", "meta-collision", "Session-Timeout im Workbench zu kurz, User fliegen raus", "wc_session_timeout", "German session timeout"),
  task("t042", "de", "meta-collision", "Token-Refresh nach Key-Rotation kaputt", "wc_jwt_refresh", "German token refresh"),
  task("t043", "de", "meta-collision", "Rate-Limit bei StatsBomb, wir kriegen 429", "wc_sb_rate", "German rate limit"),
  task("t044", "de", "meta-collision", "Usage-Dashboard zeigt falsche Monatswerte", "wc_usage_dashboard", "German usage dashboard"),
  task("t045", "de", "meta-is-task", "Limit-Banner zeigt falsches Kontingent an", "wc_limit_banner", "German limit banner"),
  // ── task: Swiss / Austrian ──
  task("t046", "ch", "dialect", "chasch du mal luege wieso de CI functional test immer timeoutet", "wc_ci_timeout", "Swiss CI timeout"),
  task("t047", "at", "dialect", "heast, de cube pipeline crasht bei de zukünftigen spiele", "wc_cube_future", "Austrian cube crash"),
  task("t048", "ch", "dialect", "de video upload goht nöd über 100 MB", "wc_video_upload", "Swiss video upload"),
  task("t049", "ch", "dialect", "s'leaderboard ladet ewig bim erschte mal", "tradeoff", "Swiss, one task word"),
  task("t050", "at", "dialect", "oida, die session fliegt nach 15 minuten raus", "wc_session_timeout", "Austrian session timeout"),
  // ── task: voice dictation ──
  task("t051", "de", "dictation", "ähm kannst du mal schauen warum die StatsBomb Extraktion ständig 429 kriegt Punkt", "wc_sb_rate", "dictated StatsBomb 429"),
  task("t052", "de", "dictation", "okay also ähm der CI functional test läuft wieder in den timeout Komma kannst du das fixen", "wc_ci_timeout", "dictated CI"),
  task("t053", "de", "dictation", "ja ähm die session timeout geschichte im workbench Komma die user fliegen nach 15 minuten raus", "wc_session_timeout", "dictated session timeout"),
  task("t054", "de", "dictation", "mach bitte den token refresh fix für die key rotation", "wc_jwt_refresh", "dictated token refresh"),
  task("t055", "de", "dictation", "ähm der usage dashboard zeigt falsche zahlen für den monat", "wc_usage_dashboard", "dictated usage dashboard"),
  // ── task: content-free opener + one task sentence ──
  task("t056", "de", "opener+task", "mach weiter, und danach schau dir bitte den StatsBomb 429 rate limit an", "wc_sb_rate", "opener + task"),
  task("t057", "de", "opener+task", "limit ist wieder da. Kannst du jetzt den session timeout im workbench fixen?", "wc_session_timeout", "limit opener + task"),
  task("t058", "en", "opener+task", "ok thanks, next: the usage dashboard monthly totals are wrong", "wc_usage_dashboard", "opener + task"),
  task("t059", "de", "opener+task", "passt, weiter. Ach ja, der CI functional timeout ist wieder da", "wc_ci_timeout", "opener + task"),
  task("t060", "en", "opener+task", "continue, but first fix the token refresh after key rotation", "wc_jwt_refresh", "opener + task"),
  task("t061", "en", "opener+task", "usage limit reset. please look at the retry storm in the import worker", "wc_retry_storm", "limit opener + task"),
  task("t062", "at", "opener+task", "jo weida, und dann noch die cube pipeline mit den events ohne spiele", "wc_cube_future", "opener + task"),
  task("t063", "de", "opener+task", "alles klar. jetzt bitte die video upload grenze bei 100 MB", "wc_video_upload", "opener + task"),
  task("t064", "en", "opener+task", "great. now the leaderboard first load performance", "wc_leaderboard_load", "opener + task"),
  task("t065", "en", "opener+task", "yes, and then the prismic preview", "wc_prismic", "opener + task"),
  // ── task: long, buried ──
  task("t066", "en", "long-buried", LONG_TASK_EN_REDIS, "wc_redis", "task buried mid-paragraph after chatter"),
  task("t067", "de", "long-buried", LONG_TASK_DE_OOM, "wc_import_oom", "task buried mid-paragraph"),
  task("t068", "mix", "long-buried", LONG_TASK_MIX_EPL, "wc_epl_id", "task buried in mixed chatter"),
  task("t069", "de", "long-buried", LONG_TASK_DICTATED_HEATMAP, "wc_heatmap", "dictated, task mid-sentence"),
  task("t070", "en", "long-buried", LONG_TASK_EN_WHATSAPP, "wc_whatsapp", "limit chatter + task"),
  task("t071", "en", "long-buried", LONG_TASK_EN_LATE, "wc_pass_options", "task after 30+ unrelated content words"),
  task("t072", "en", "long-buried", LONG_TASK_EN_PAST_SLICE, "wc_quota_cron", "task after 2000 chars of noise"),
  // ── task: code-ish ──
  task("t073", "en", "code", "TypeError: Cannot read properties of undefined (reading 'retryAfter')\n    at StatsBombClient.fetchMatch (packages/extraction-worker/src/statsbomb/client.ts:142:31)\n    at async extractBatch (packages/extraction-worker/src/statsbomb/batch.ts:58:9)", "wc_sb_rate", "stack trace alone"),
  task("t074", "en", "code", "packages/api/src/auth/session.ts", "wc_session_timeout", "file path alone"),
  task("t075", "en", "code", "src/auth/jwks.ts", "wc_jwt_refresh", "partial path alone"),
  task("t076", "en", "code", "Error: 429 Too Many Requests", "wc_sb_rate", "error message alone"),
  task("t077", "en", "code", "ECONNRESET in import worker after restart", "wc_retry_storm", "error + context"),
  task("t078", "en", "code", "FATAL: sorry, too many clients already", null, "error alone, no tree"),
  task("t079", "en", "code", "jwks.ts", "wc_jwt_refresh", "basename alone"),
  task("t080", "en", "code", "PayloadTooLargeError: request entity too large (413)", "wc_video_upload", "error alone"),
  task("t081", "en", "code", "    at Object.<anonymous> (packages/cube/src/pipeline/run.ts:88:14)\nError: no events for match 3869151", "wc_cube_future", "stack frame + error"),
  task("t082", "en", "code", "ci.yml", "wc_ci_timeout", "basename alone"),
  task("t083", "en", "code", "refreshAccessToken throws invalid signature", "wc_jwt_refresh", "symbol + error"),
  // ── task: questions that are tasks ──
  task("t084", "de", "question", "warum ist der session timeout im workbench 15 minuten?", "wc_session_timeout", "question about the product, not the agent"),
  task("t085", "en", "question", "why does the usage dashboard sum all organizations?", "wc_usage_dashboard", "question about the product"),
  // ── task: no matching tree ──
  task("t086", "en", "no-tree", "add dark mode to the settings page", null, "feature, no tree"),
  task("t087", "en", "no-tree", "refactor the player search to use the new index", null, "refactor, no tree"),
  task("t088", "de", "no-tree", "schreib einen test für die xG-Berechnung", null, "test with an object"),
  task("t089", "en", "no-tree", "rename the column goals_per_90 to goals_p90", null, "rename"),
  task("t090", "de", "no-tree", "die Spielerliste soll nach Position sortiert werden", null, "feature"),
  task("t091", "en", "no-tree", "upgrade drizzle to 0.46", null, "upgrade"),
  task("t092", "en", "no-tree", "fix typo in the onboarding email", null, "fix with object"),
  task("t093", "en", "no-tree", "migrate the scouting notes to the new table", null, "migration"),
  task("t094", "de", "no-tree", "wie berechnen wir progressive passes?", null, "domain question"),
  task("t095", "en", "no-tree", "add pagination to /api/players", null, "feature with path"),
  task("t096", "de", "single-word", "JWT geht nicht", "tradeoff", "DESIGN's accepted single-noun miss"),
  task("t097", "en", "single-word", "CI?", "tradeoff", "single capital pair"),
  // ── task: operation word + object ──
  task("t098", "en", "operation-object", "run the cube pipeline for the scheduled games", "wc_cube_future", "operation + object"),
  task("t099", "en", "operation-object", "commit the fix for the retry storm", "wc_retry_storm", "operation + object"),
  task("t100", "en", "operation-object", "review the rate limiting middleware PR", "wc_rate_mw", "operation + object"),
  task("t101", "en", "operation-object", "test the token refresh after rotation", "wc_jwt_refresh", "operation + object"),
  task("t102", "en", "operation-object", "deploy the session timeout fix to staging", "wc_session_timeout", "operation + object"),
  task("t103", "en", "operation-object", "merge the usage dashboard fix", "wc_usage_dashboard", "operation + object"),
  task("t104", "en", "operation-object", "check why the weekly report email is stale", "wc_weekly_report", "operation + object"),
  task("t105", "en", "operation-object", "push the quota cron fix", "wc_quota_cron", "operation + object"),
  // ── task: typos in task words ──
  task("t106", "en", "typo", "statsbmob rate limt 429", "wc_sb_rate", "typo in topic word"),
  task("t107", "de", "typo", "sesion timout im workbnech", "wc_session_timeout", "every topic word misspelt"),
  task("t108", "en", "typo", "usgae dashbaord monthly totals wrong", "wc_usage_dashboard", "typos, two words intact"),
  task("t109", "en", "typo", "toekn refresh after key rotaiton", "wc_jwt_refresh", "typos, two words intact"),
  // ── task: more ──
  task("t110", "de", "meta-collision", "Wieso ignoriert der Extraction Worker den Retry-After Header?", "wc_sb_rate", "German question about the worker"),
  task("t111", "de", "code", "Kannst du die Funktion retryWithBackoff anschauen?", "wc_sb_rate", "symbol named"),
  task("t112", "en", "short", "the gateway rejects uploads above 100 MB", "wc_video_upload", "video upload"),
  task("t113", "en", "short", "JWKS should keep the old signing key after rotation", "wc_jwt_refresh", "decision topic"),
  task("t114", "en", "short", "functional test timeout in CI should be 20 seconds", "wc_ci_timeout", "decision topic"),
  task("t115", "de", "short", "warum zählt das usage dashboard alle organisationen zusammen", "wc_usage_dashboard", "German usage"),
  task("t116", "de", "short", "cube crasht bei matches ohne events", "wc_cube_future", "German cube"),
  task("t117", "en", "meta-collision", "the import worker saturates the database after restart", "wc_retry_storm", "restart is context of a bug"),
  task("t118", "de", "single-word", "heatmap ist bei weitwinkel verschoben", "tradeoff", "one English task word"),
  task("t119", "en", "short", "EPL competition id in staging", "wc_epl_id", "EPL"),
  task("t120", "en", "short", "scouting feed loses entries when redis evicts", "wc_redis", "redis"),
  task("t121", "en", "short", "prismic website preview shows 404", "wc_prismic", "prismic"),
  task("t122", "en", "short", "metric glossary tooltips missing in leaderboard", "wc_glossary", "glossary"),
  task("t123", "en", "short", "bot status line appears twice in whatsapp", "wc_whatsapp", "whatsapp"),
  task("t124", "en", "meta-is-task", "the daily quota counter resets twice a day", "wc_quota_cron", "META words + one object word"),
  task("t125", "en", "operation-object", "large files block the pre-commit hook on push", "wc_commit_hook", "commit hook"),
  task("t126", "en", "operation-object", "test runner keeps rerunning failed tests", "wc_test_runner", "test runner"),
  task("t127", "en", "operation-object", "main build cache gets invalidated on every push", "wc_build_cache", "build cache"),
  task("t128", "en", "short", "should we raise the PGlite pool size for the timeouts", "wc_pglite_pool", "rejected approach"),
  task("t129", "mix", "meta-collision", "context tokens überschreiten 200k in der deferred composition", "wc_context_overflow", "mixed context bug"),
  task("t130", "en", "meta-is-task", "session resume after limit reset loses context", "wc_session_resume", "all META but a bug report"),
  task("t131", "en", "meta-is-task", "the weekly limit resets at the wrong hour", null, "product bug in META words, no tree"),
  task("t132", "en", "meta-collision", "retry limit for failed imports is too low", "wc_retry_storm", "retry limit config"),
  task("t133", "en", "meta-collision", "token expired error on the public API", "wc_rate_mw", "token error on public API"),
  task("t134", "en", "meta-is-task", "usage window for the bot is computed in UTC instead of local time", "wc_token_usage", "usage window bug"),
  task("t135", "de", "meta-is-task", "das Kontingent-Banner rechnet mit dem Plan-Limit statt dem Restguthaben", "wc_limit_banner", "German banner bug"),
];
