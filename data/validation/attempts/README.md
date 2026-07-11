# Non-activating validation attempts

This directory preserves signed, immutable trusted-host validation attempts that
did not meet the activation threshold. They are experimental evidence, not
activation receipts. Canonical activation receipts live one level above and are
the only receipts bound to active strategies.

Any retry after a recorded failure uses a successor strategy version; an attempt
file is never overwritten or promoted in place.
