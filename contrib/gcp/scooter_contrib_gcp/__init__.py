"""Google Cloud integration for Scooter's broker, as a contrib module.

Puts a fixed set of *.googleapis.com hosts behind the broker's forge proxy, which
injects a service-account token, so gcloud and terraform in the sandbox reach the
real APIs without holding a credential. Nothing imports the broker app.
"""
