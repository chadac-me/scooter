# ask-user's declaration: the agent asks the user multiple-choice questions and waits
# for the answers. Claude's AskUserQuestion is made a blocking tool whose input is
# sent as an `ask-user.questions` request, and ui/QuestionCard.tsx draws that request
# in the Approvals tab. No service half: its database is owned by agent-host.
{
  contribs.ask-user = {
    src = ./.;
    agent.blockingTools.AskUserQuestion = {
      kind = "ask-user.questions";
      title = "The agent has a question";
      dismissed =
        "The user dismissed these questions without answering. Do not ask them again: "
        + "proceed with your best judgement and say which option you assumed.";
    };
    ui.interruptRenderers."ask-user.questions".entry = "ui/QuestionCard.tsx";

    # Which conversations wait on the user, for the sidebar's "!" (sql/schema.sql).
    db = {
      enable = true;
      owner = "agent-host";
      provides = [ "awaiting-input" ];
      tables.conversation_awaiting_input = {
        writers = [ "agent-host" ];
        readers = [ "conversation-router" ];
        note = ''
          Which conversations are waiting on the user's answer, for the sidebar's "!". The
          agent-host sets and clears it; the router reads it for GET /conversations.'';
      };
    };
  };
}
