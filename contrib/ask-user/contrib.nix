# ask-user's declaration: the agent asks the user multiple-choice questions and waits
# for the answers. Claude's AskUserQuestion is made a blocking tool whose input is
# sent as an `ask-user.questions` request, and ui/QuestionCard.tsx draws that request
# in the Approvals tab. UI and agent config only; no service half.
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
  };
}
