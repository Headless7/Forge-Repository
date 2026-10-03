/** Seeded demo accounts (development only — shown on the sign-in page when DEMO_MODE=true). */
export const DEMO_PASSWORD = "demo1234";

export const DEMO_ACCOUNTS = [
  { email: "giorgos@nightfall.gg", name: "Giorgos Petrou", username: "giorgos", role: "OWNER", title: "Studio Lead", hint: "Owner · reviews work" },
  { email: "lena@nightfall.gg", name: "Lena Fischer", username: "lena", role: "MANAGER", title: "Producer", hint: "Manager · reviews work" },
  { email: "james@nightfall.gg", name: "James Walker", username: "james", role: "CONTRIBUTOR", title: "VFX Artist", hint: "Contributor · VFX artist" },
  { email: "alex@nightfall.gg", name: "Alex Kim", username: "alex", role: "CONTRIBUTOR", title: "Animator", hint: "Contributor · animator" },
  { email: "sofia@nightfall.gg", name: "Sofia Reyes", username: "sofia", role: "CONTRIBUTOR", title: "UI Designer", hint: "Contributor · UI designer" },
  { email: "mike@nightfall.gg", name: "Mike Novak", username: "mike", role: "CONTRIBUTOR", title: "3D Modeler", hint: "Contributor · models & maps" },
  { email: "kenji@nightfall.gg", name: "Kenji Sato", username: "kenji", role: "DEVELOPER", title: "Gameplay Programmer", hint: "Developer · scripting" },
  { email: "ruby@nightfall.gg", name: "Ruby Chen", username: "ruby", role: "VIEWER", title: "Community Manager", hint: "Viewer · read-only" },
  { email: "omar@emberlight.dev", name: "Omar Haddad", username: "omar", role: "OWNER", title: "Founder", hint: "Other studio (Emberlight)" },
] as const;
