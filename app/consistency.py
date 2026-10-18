"""Interview summary + 'possible differences for human review'.

This is a transparent keyword heuristic, NOT lie detection. Two answers can differ because of wording, memory,
clarification or a misunderstood question. Nothing here is a finding about honesty.
"""
import re
from datetime import datetime

STOP = set("""about above after again against also always another because been before being below between both
could does doing down during each from further have having here herself himself into itself just like more most
myself once only other ourselves over same should some such than that their theirs them themselves then there
these they this those through under until very want were what when where which while whom with would your yours
yourself yourselves went got get was and the for are but not you all any can had her him his how its our out she
who why will""".split())
NEG = {"no", "not", "never", "didn't", "didnt", "don't", "dont", "wasn't", "wasnt", "weren't", "haven't", "hadn't",
       "none", "nobody", "nothing", "nowhere", "cannot", "can't", "cant", "won't", "couldn't", "neither", "nor"}
WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")
TIME = re.compile(r"\b(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b", re.I)
NUM = re.compile(r"\b\d+(?:[.,]\d+)?\b")


def _tokens(text):
    return {w.lower() for w in WORD.findall(text) if len(w) >= 4 and w.lower() not in STOP}


def _has_neg(text):
    return any(w.lower().replace("’", "'") in NEG for w in WORD.findall(text))


def _times(text):
    out = set()
    for m in TIME.finditer(text):
        if m.group(1) is not None:
            hh, mm, ap = int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower()
        else:
            hh, mm, ap = int(m.group(4)), 0, m.group(5).lower()
        if ap == "pm" and hh < 12:
            hh += 12
        if ap == "am" and hh == 12:
            hh = 0
        if 0 <= hh < 24 and 0 <= mm < 60:
            out.add(hh * 60 + mm)
    return out


def _numbers(text):
    return {n.replace(",", "") for n in NUM.findall(TIME.sub(" ", text))}


def find_differences(items):
    """items: dicts with position, question_text, topic, response_text. Returns findings for human review."""
    answered = [i for i in items if (i.get("response_text") or "").strip()]
    out = []
    for a in range(len(answered)):
        for b in range(a + 1, len(answered)):
            x, y = answered[a], answered[b]
            same_topic = bool(x.get("topic")) and x.get("topic", "").strip().lower() == y.get("topic", "").strip().lower()
            shared = sorted(_tokens(x["response_text"]) & _tokens(y["response_text"]))
            if len(shared) < (1 if same_topic else 2):
                continue
            reasons = []
            if _has_neg(x["response_text"]) != _has_neg(y["response_text"]):
                reasons.append(("polarity", "One answer contains a negation and the other does not, on overlapping terms."))
            t1, t2 = _times(x["response_text"]), _times(y["response_text"])
            if t1 and t2 and not (t1 & t2):
                fmt = lambda s: ", ".join(f"{m // 60:02d}:{m % 60:02d}" for m in sorted(s))
                reasons.append(("time", f"Different clock times mentioned ({fmt(t1)} vs {fmt(t2)}) on overlapping terms."))
            n1, n2 = _numbers(x["response_text"]), _numbers(y["response_text"])
            if n1 and n2 and not (n1 & n2):
                reasons.append(("figures", f"Different figures mentioned ({', '.join(sorted(n1))} vs {', '.join(sorted(n2))})."))
            for kind, text in reasons:
                out.append({"type": kind, "positions": [x["position"], y["position"]], "shared_terms": shared[:8],
                            "detail": text,
                            "caution": "Possible difference for human review only. Not an indication of deception."})
    return out


def _parse(ts):
    try:
        return datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None


def build_summary(interview, items):
    answered = [i for i in items if (i.get("response_text") or "").strip()]
    times = [t for t in (_parse(i.get("answered_at")) for i in answered) if t]
    span = (max(times) - min(times)).total_seconds() if len(times) > 1 else None
    return {
        "generated_for": interview.get("id"),
        "total_questions": len(items),
        "answered": len(answered),
        "unanswered_positions": [i["position"] for i in items if i not in answered],
        "follow_up_positions": [i["position"] for i in items if i.get("follow_up")],
        "items_with_notes": [i["position"] for i in items if (i.get("notes") or "").strip()],
        "recordings": [i["position"] for i in items if i.get("rec_stored")],
        "word_counts": {str(i["position"]): len(i["response_text"].split()) for i in answered},
        "first_to_last_answer_seconds": span,
        "differences_for_review": find_differences(items),
        "note": "Summary is descriptive. 'Differences for review' are keyword heuristics and are not findings about honesty.",
    }
